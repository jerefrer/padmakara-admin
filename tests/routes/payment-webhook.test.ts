import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Real-Easypay webhook path (the other payment test file covers mock mode only).
 *
 * `isMockMode` in src/routes/payment.ts is a module-level const derived from
 * config.easypay.accountId, so the env has to be in place before any import runs —
 * hence vi.hoisted rather than a plain assignment.
 */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

/** Set per-test: what the paymentTransactions insert returns. Empty = duplicate. */
let insertReturns: Array<{ id: number }> = [{ id: 1 }];
/** Every db.update() call, so tests can tell the users update from the ledger update. */
let updateCalls: Array<{ table: unknown; set: Record<string, any> | null }> = [];

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(insertReturns)),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => {
      const entry: { table: unknown; set: Record<string, any> | null } = {
        table,
        set: null,
      };
      updateCalls.push(entry);
      return {
        set: vi.fn((value: Record<string, any>) => {
          entry.set = value;
          return { where: vi.fn(() => Promise.resolve(undefined)) };
        }),
      };
    }),
  },
}));

import { testJson } from "../helpers.ts";
import { db } from "../../src/db/index.ts";
import { users } from "../../src/db/schema/users.ts";
import { paymentTransactions } from "../../src/db/schema/payment-transactions.ts";

/** The real shape of GET /2.0/subscription/:id — no `order`, no top-level `status`. */
function easypaySubscription(overrides: Record<string, any> = {}) {
  return {
    id: "sub-abc",
    key: "",
    value: 5,
    currency: "EUR",
    customer: { key: "user-7", email: "member@test.com" },
    method: { type: "DD", status: "active" },
    ...overrides,
  };
}

function stubEasypay(payload: unknown, ok = true) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as unknown as Response),
  ) as unknown as typeof fetch;
}

function notify(body: Record<string, unknown>) {
  return testJson("/api/payment/webhook", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function usersUpdate() {
  return updateCalls.find((c) => c.table === users)?.set ?? null;
}

/** The ledger row records the user we resolved, so it shows *which* user we picked. */
function ledgerUpdate() {
  return updateCalls.find((c) => c.table === paymentTransactions)?.set ?? null;
}

const capture = {
  id: "sub-abc",
  type: "capture",
  status: "success",
  date: "2026-08-05 10:00:00",
};

describe("POST /api/payment/webhook (real Easypay)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturns = [{ id: 1 }];
    updateCalls = [];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7,
      subscriptionStatus: "none",
      subscriptionExpiresAt: null,
      subscriptionAmount: null,
    });
  });

  it("activates the subscription using customer.key", async () => {
    stubEasypay(easypaySubscription());

    const { status, body } = await notify(capture);

    expect(status).toBe(200);
    expect(body.received).toBe(true);

    const set = usersUpdate();
    expect(set).toMatchObject({
      subscriptionStatus: "active",
      subscriptionSource: "easypay",
      easypaySubscriptionId: "sub-abc",
      subscriptionAmount: "5",
    });
    expect(set!.subscriptionExpiresAt).toBeInstanceOf(Date);
  });

  it("ignores the caller-supplied key and uses only Easypay's customer.key", async () => {
    // The body claims user 99; Easypay says user 7. Only Easypay is authoritative —
    // this endpoint is unauthenticated, so trusting the body would be an account takeover.
    stubEasypay(easypaySubscription({ customer: { key: "user-7" } }));

    await notify({ ...capture, key: "user-99" });

    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "active" });
    // The ledger records who we credited: user 7 from customer.key, never 99 from the body.
    expect(ledgerUpdate()).toMatchObject({ userId: 7, action: "activated" });
  });

  it("touches no user when customer.key is absent, even with a key in the body", async () => {
    stubEasypay(easypaySubscription({ customer: { key: "" } }));

    const { status, body } = await notify({ ...capture, key: "user-99" });

    expect(status).toBe(200);
    expect(body.received).toBe(true);
    expect(db.query.users.findFirst).not.toHaveBeenCalled();
    expect(usersUpdate()).toBeNull();
  });

  it("does not extend twice for a replayed notification", async () => {
    stubEasypay(easypaySubscription());
    insertReturns = []; // unique dedupe_key already present

    const { status, body } = await notify(capture);

    expect(status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(usersUpdate()).toBeNull();
  });

  it("extends from the existing paid-through date, not from now", async () => {
    const existing = new Date();
    existing.setDate(existing.getDate() + 20);
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7,
      subscriptionStatus: "active",
      subscriptionExpiresAt: existing,
      subscriptionAmount: "5",
    });
    stubEasypay(easypaySubscription());

    await notify(capture);

    const expiresAt = usersUpdate()!.subscriptionExpiresAt as Date;
    const daysOut = (expiresAt.getTime() - Date.now()) / 86_400_000;
    // 20 days remaining + 1 month, so well beyond a single month from today.
    expect(daysOut).toBeGreaterThan(45);
  });

  it("leaves access alone when a charge fails", async () => {
    stubEasypay(easypaySubscription());

    const { status } = await notify({ ...capture, status: "failed" });

    // Easypay retries on its own and access lapses at the paid-through date plus
    // grace — revoking here would cut off a member over one transient decline.
    expect(status).toBe(200);
    expect(usersUpdate()).toBeNull();
  });

  it("closes access on a chargeback", async () => {
    stubEasypay(easypaySubscription());

    await notify({ ...capture, type: "chargeback", status: "success" });

    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "expired" });
  });

  it("records but does not act on a notification Easypay cannot confirm", async () => {
    stubEasypay({ status: "error", message: ["Subscription Not Found"] }, false);

    const { status, body } = await notify(capture);

    expect(status).toBe(200);
    expect(body.received).toBe(true);
    expect(usersUpdate()).toBeNull();
  });

  it("takes no action on an unrecognised notification type", async () => {
    stubEasypay(easypaySubscription());

    const { status } = await notify({ ...capture, type: "something-new" });

    expect(status).toBe(200);
    expect(usersUpdate()).toBeNull();
  });

  it("answers 200 to a malformed body so Easypay stops retrying", async () => {
    const res = await testJson("/api/payment/webhook", {
      method: "POST",
      body: "not json",
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
