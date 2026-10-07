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

  it("activates on subscription_capture, the type Easypay really sends", async () => {
    // Shape copied from the first live notification (2026-09-09), with status flipped.
    stubEasypay(easypaySubscription());

    await notify({
      id: "sub-abc",
      key: "",
      type: "subscription_capture",
      status: "success",
      messages: [],
      date: "2026-10-09 11:50:06",
    });

    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "active" });
  });

  it("leaves access alone on a failed subscription_capture (AM04 insufficient funds)", async () => {
    stubEasypay(easypaySubscription());

    await notify({
      id: "sub-abc",
      key: "",
      type: "subscription_capture",
      status: "failed",
      messages: ["AM04 - Insuficiência de fundos"],
      date: "2026-09-09 11:50:06",
    });

    expect(usersUpdate()).toBeNull();
    expect(ledgerUpdate()).toMatchObject({ action: "ignored", note: "payment_failed" });
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

  const create = { id: "sub-new", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" };

  it("should not grant access on subscription_create", async () => {
    stubEasypay(easypaySubscription({ id: "sub-new" }));
    await notify(create);
    expect(usersUpdate()?.subscriptionStatus).toBeUndefined();
    expect(ledgerUpdate()).toMatchObject({ action: "tokenized" });
  });

  it("should swap the stored subscription and deactivate the old one on a card update", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: null,
    });
    stubEasypay(easypaySubscription({ id: "sub-new" }));
    await notify(create);
    const calls = (global.fetch as any).mock.calls.map((c: any[]) => [c[0], c[1]?.method]);
    expect(calls).toContainEqual([expect.stringContaining("/subscription/sub-old"), "PATCH"]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "sub-new", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "method_updated" });
  });

  it("should extend a yearly member by a year", async () => {
    stubEasypay(easypaySubscription({ frequency: "1Y" }));
    await notify(capture);
    const days = ((usersUpdate()!.subscriptionExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });
});

describe("POST /api/payment/subscribe (real Easypay)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 5,
      email: "member@test.com",
      firstName: "Test",
      lastName: "Member",
      subscriptionStatus: "none",
    });
    fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "chk-1", session: "sess" }),
      } as unknown as Response),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { createAccessToken } = await import("../../src/services/auth.ts");
    token = await createAccessToken({ sub: 5, email: "member@test.com", role: "user" });
  });

  it("should charge once at signup and start the recurring cycle a month later", async () => {
    // Regression: capture_now plus a start_time a few minutes out made Easypay charge
    // the first month twice (once at signup, once when the first cycle started).
    const { status } = await testJson("/api/payment/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month" }),
    });

    expect(status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.payment.capture_now).toBe(true);
    expect(sent.payment.frequency).toBe("1M");
    expect(sent.order.value).toBe(10);
    expect(sent.payment.capture.descriptive).toBe("Padmakara membership");
    const start = new Date(sent.payment.start_time.replace(" ", "T") + ":00Z");
    const daysOut = (start.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(27);
    expect(daysOut).toBeLessThan(32);
  });

  it("should create a yearly membership starting its cycle a year later", async () => {
    const { status } = await testJson("/api/payment/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 120, interval: "year" }),
    });
    expect(status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.payment.frequency).toBe("1Y");
    const days = (new Date(sent.payment.start_time.replace(" ", "T") + ":00Z").getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });

  it.each([[{ amount: 1, interval: "month" }], [{ amount: 50, interval: "year" }], [{ amount: "x", interval: "month" }], [{}]])(
    "should reject an invalid contribution %j with 400 and no Easypay call",
    async (payload) => {
      const res = await testJson("/api/payment/subscribe", {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CONTRIBUTION");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("should carry amount, interval and language on the checkout page URL", async () => {
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month", language: "pt" }),
    });
    expect(res.body.url).toContain("amount=10&interval=month&lang=pt");
  });
});
