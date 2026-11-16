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
/** Set per-test: what a ledger lookup (db.select) returns, e.g. a `replaced <id>` row. */
let selectReturns: Array<Record<string, unknown>> = [];
/**
 * Optional per-test resolver that sees the rendered WHERE clause of a ledger lookup, so a
 * test can make the answer depend on what was asked instead of returning the same rows
 * for every query. When null, `selectReturns` answers everything.
 */
let selectResolver: ((q: { sql: string; params: unknown[] }) => Array<Record<string, unknown>>) | null = null;
const pgDialect = new PgDialect();
const answerSelect = (cond: unknown) =>
  Promise.resolve(selectResolver ? selectResolver(pgDialect.sqlToQuery(cond as SQL)) : selectReturns);
/** Every table passed to db.delete(), so tests can see a released claim. */
let deleteCalls: unknown[] = [];
/** Every payload passed to db.insert().values(), so tests can see ledger rows we write. */
let insertedValues: Array<Record<string, any>> = [];
/**
 * Capture ids already in the ledger: stands in for the unique `easypay_transaction_id`
 * constraint, so a second credit of the same capture loses exactly as it would in Postgres.
 */
let creditedCaptureIds = new Set<string>();
/** Set per-test to make the write that extends a member throw, like a database that went away mid-request. */
let failUserWrite = false;
/** Credit rows the stand-in constraint accepted, in order. */
let acceptedCredits: Array<Record<string, any>> = [];

vi.mock("../../src/db/index.ts", () => {
  const mockDb: Record<string, any> = {
    query: {
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, any>) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => {
              if (!v.easypayTransactionId) return Promise.resolve(insertReturns);
              if (creditedCaptureIds.has(v.easypayTransactionId)) return Promise.resolve([]);
              creditedCaptureIds.add(v.easypayTransactionId);
              acceptedCredits.push(v);
              return Promise.resolve([{ id: 100 + creditedCaptureIds.size }]);
            }),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => ({
          limit: vi.fn(() => answerSelect(cond)),
          orderBy: vi.fn(() => ({ limit: vi.fn(() => answerSelect(cond)) })),
          // The row lock taken before computing a new expiry: the member as findFirst sees them.
          for: vi.fn(async () => [await mockDb.query.users.findFirst()]),
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => {
      deleteCalls.push(table);
      return { where: vi.fn(() => Promise.resolve(undefined)) };
    }),
    update: vi.fn((table: unknown) => {
      const entry: { table: unknown; set: Record<string, any> | null } = {
        table,
        set: null,
      };
      updateCalls.push(entry);
      return {
        set: vi.fn((value: Record<string, any>) => {
          entry.set = value;
          if (failUserWrite && "subscriptionExpiresAt" in value) {
            return { where: vi.fn(() => Promise.reject(new Error("connection terminated"))) };
          }
          return { where: vi.fn(() => Promise.resolve(undefined)) };
        }),
      };
    }),
  };
  mockDb.selectDistinct = mockDb.select;
  mockDb.transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockDb));
  return { db: mockDb };
});

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { config } from "../../src/config.ts";
import { sendEmail } from "../../src/services/email.ts";
import { testJson } from "../helpers.ts";
import { db } from "../../src/db/index.ts";
import { users } from "../../src/db/schema/users.ts";
import { paymentTransactions } from "../../src/db/schema/payment-transactions.ts";

/**
 * The real shape of GET /2.0/subscription/:id — no `order`, no top-level `status`. With no
 * capture yet: production stores this shape after subscription_create and after a failed
 * capture, with no `transactions` key at all.
 */
function easypaySubscription(overrides: Record<string, any> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    key: "",
    value: 5,
    currency: "EUR",
    customer: { key: "user-7", email: "member@test.com" },
    method: { type: "DD", status: "active" },
    ...overrides,
  };
}

/** An Easypay timestamp ("2026-10-07 14:06:15", UTC, no zone) `minutes` before now. */
function easypayAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

/** A subscription as Easypay reports it right after a card was stored: created a minute ago. */
function freshSubscription(overrides: Record<string, any> = {}) {
  return easypaySubscription({ created_at: easypayAgo(1), ...overrides });
}

const CAPTURE_1 = "00000000-0000-4000-8000-00000000c001";
const CAPTURE_2 = "00000000-0000-4000-8000-00000000c002";

/** One entry of `transactions`, in the shape stored in production after a successful capture. */
function paidCapture(id = CAPTURE_1, overrides: Record<string, any> = {}) {
  const at = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    id,
    key: "",
    date: at,
    method: "cc",
    values: { tax: 0.01, paid: 5, transfer: 4.8, fixed_fee: 0.1, requested: 5, variable_fee: 0.09 },
    created_at: at,
    descriptive: null,
    transfer_date: at,
    transfer_batch: null,
    document_number: "DOC",
    ...overrides,
  };
}

/** A subscription whose Easypay record lists `captures` (one paid capture by default). */
function paidSubscription(overrides: Record<string, any> = {}, captures: unknown[] = [paidCapture()]) {
  return easypaySubscription({ transactions: captures, ...overrides });
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

/**
 * Routes Easypay by method: GET /subscription/:id returns `sub`, PATCH answers
 * `patchOk`. Records every call so tests can see which subscription was stopped.
 */
function stubEasypayRoutes(sub: unknown, { patchOk = true } = {}) {
  global.fetch = vi.fn((_url: string, init: RequestInit = {}) => {
    const ok = (init.method ?? "GET") === "PATCH" ? patchOk : true;
    const payload = (init.method ?? "GET") === "GET" ? sub : {};
    return Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

/**
 * GET /subscription/:id answers from `subs` by id (404 for an unknown id); PATCH answers
 * with `patchStatus`, or rejects like a dropped connection when `patchStatus` is "network".
 */
function stubEasypayById(subs: Record<string, any>, { patchStatus = 200 as number | "network" } = {}) {
  global.fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "PATCH") {
      if (patchStatus === "network") return Promise.reject(new TypeError("fetch failed"));
      const ok = patchStatus < 400;
      return Promise.resolve({
        ok, status: patchStatus, json: () => Promise.resolve({}), text: () => Promise.resolve("{}"),
      } as unknown as Response);
    }
    const sub = subs[url.split("/subscription/")[1] ?? ""];
    return Promise.resolve({
      ok: !!sub, status: sub ? 200 : 404,
      json: () => Promise.resolve(sub ?? {}), text: () => Promise.resolve(JSON.stringify(sub ?? {})),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

/**
 * GET answers by path after `/2.0` (404 for an unknown path; an entry of `{ httpStatus }`
 * answers that status); PATCH always succeeds.
 */
function stubEasypayPaths(routes: Record<string, any>) {
  global.fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const hit = (init.method ?? "GET") === "PATCH" ? {} : routes[url.replace(/^.*\/2\.0/, "")];
    const status = hit === undefined ? 404 : typeof hit.httpStatus === "number" ? hit.httpStatus : 200;
    return Promise.resolve({
      ok: status < 400, status,
      json: () => Promise.resolve(hit ?? {}), text: () => Promise.resolve(JSON.stringify(hit ?? {})),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

function patchBodies(): Array<[string, string]> {
  return (global.fetch as any).mock.calls
    .filter((c: any[]) => c[1]?.method === "PATCH")
    .map((c: any[]) => [c[0] as string, c[1].body as string]);
}

function patchedUrls(): string[] {
  return (global.fetch as any).mock.calls
    .filter((c: any[]) => c[1]?.method === "PATCH")
    .map((c: any[]) => c[0] as string);
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

/** Ledger rows that credited a capture (one per Easypay capture the stand-in constraint accepted). */
function creditRows() {
  return acceptedCredits;
}

function usersUpdates() {
  return updateCalls
    .filter((c) => c.table === users)
    .map((c) => c.set)
    .filter((set): set is Record<string, any> => set !== null);
}

const capture = {
  id: "00000000-0000-4000-8000-0000000000a1",
  type: "capture",
  status: "success",
  date: "2026-08-05 10:00:00",
};

describe("POST /api/payment/webhook (real Easypay)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturns = [{ id: 1 }];
    updateCalls = [];
    selectReturns = [];
    selectResolver = null;
    deleteCalls = [];
    insertedValues = [];
    creditedCaptureIds = new Set();
    failUserWrite = false;
    acceptedCredits = [];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7,
      subscriptionStatus: "none",
      subscriptionExpiresAt: null,
      subscriptionAmount: null,
    });
  });

  it("activates the subscription using customer.key", async () => {
    stubEasypay(paidSubscription());

    const { status, body } = await notify(capture);

    expect(status).toBe(200);
    expect(body.received).toBe(true);

    const set = usersUpdate();
    expect(set).toMatchObject({
      subscriptionStatus: "active",
      subscriptionSource: "easypay",
      easypaySubscriptionId: "00000000-0000-4000-8000-0000000000a1",
      subscriptionAmount: "5",
    });
    expect(set!.subscriptionExpiresAt).toBeInstanceOf(Date);
  });

  it("activates on subscription_capture, the type Easypay really sends", async () => {
    // Shape copied from the first live notification (2026-09-09), with status flipped.
    stubEasypay(paidSubscription());

    await notify({
      id: "00000000-0000-4000-8000-0000000000a1",
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
      id: "00000000-0000-4000-8000-0000000000a1",
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
    stubEasypay(paidSubscription({ customer: { key: "user-7" } }));

    await notify({ ...capture, key: "user-99" });

    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "active" });
    // The ledger records who we credited: user 7 from customer.key, never 99 from the body.
    expect(creditRows()).toEqual([expect.objectContaining({ userId: 7, action: "activated" })]);
  });

  it("touches no user when customer.key is absent, even with a key in the body", async () => {
    stubEasypay(paidSubscription({ customer: { key: "" } }));

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
    stubEasypay(paidSubscription());

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

  it("closes access on a chargeback Easypay reports on a capture we credited", async () => {
    const CHARGEBACK = "00000000-0000-4000-8000-0000000000cb";
    stubEasypayPaths({
      [`/chargeback/${CHARGEBACK}`]: {
        id: CHARGEBACK, code: "MD06", message: "MD06 - Refund Request by End Customer", amount: 5,
        capture: { id: CAPTURE_1, payment_id: "00000000-0000-4000-8000-0000000000a1", payment_type: "SUBSCRIPTION" },
      },
    });
    // The ledger has credited CAPTURE_1 to user 7 through subscription a1.
    selectResolver = ({ params }) =>
      params.includes(CAPTURE_1)
        ? [{ id: 40, userId: 7, notificationId: "00000000-0000-4000-8000-0000000000a1", action: "extended", easypayTransactionId: CAPTURE_1, createdAt: new Date(), rawSubscription: null }]
        : [];

    const { status } = await notify({ ...capture, id: CHARGEBACK, type: "chargeback", status: "success" });

    expect(status).toBe(200);
    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "expired" });
    expect(ledgerUpdate()).toMatchObject({ userId: 7, action: "reversed" });
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

  const create = { id: "00000000-0000-4000-8000-0000000000b2", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" };

  it("should not grant access on subscription_create", async () => {
    stubEasypay(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    await notify(create);
    expect(usersUpdate()?.subscriptionStatus).toBeUndefined();
    expect(ledgerUpdate()).toMatchObject({ action: "tokenized" });
  });

  it("should store the id of a member with none, with no deactivation, on subscription_create", async () => {
    // (default member has no easypaySubscriptionId)
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    const { status } = await notify(create);
    expect(status).toBe(200);
    expect(patchedUrls()).toEqual([]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "tokenized" });
  });

  it("should neither deactivate nor rewrite anything when subscription_create names the stored id", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    const { status } = await notify(create);
    expect(status).toBe(200);
    expect(patchedUrls()).toEqual([]);
    expect(usersUpdate()).toBeNull();
    expect(ledgerUpdate()).toMatchObject({ action: "tokenized" });
  });

  it("should leave the user untouched on a failed subscription_create", async () => {
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    const { status } = await notify({ ...create, status: "failed" });
    expect(status).toBe(200);
    expect(patchedUrls()).toEqual([]);
    expect(usersUpdate()).toBeNull();
    expect(ledgerUpdate()).toMatchObject({ action: "ignored" });
  });

  it("should send exactly {\"status\":\"inactive\"} when it deactivates the replaced subscription", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    await notify(create);
    const patch = (global.fetch as any).mock.calls.find((c: any[]) => c[1]?.method === "PATCH");
    expect(patch[0]).toContain("/subscription/00000000-0000-4000-8000-0000000000c3");
    expect(patch[1].body).toBe('{"status":"inactive"}');
  });

  it("should swap the stored subscription and deactivate the old one on a card update", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null,
    });
    stubEasypay(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }));
    await notify(create);
    const calls = (global.fetch as any).mock.calls.map((c: any[]) => [c[0], c[1]?.method]);
    expect(calls).toContainEqual([expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000c3"), "PATCH"]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "method_updated" });
  });

  it("should deactivate the stored subscription and adopt the new one when a capture arrives before its subscription_create", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(paidSubscription());

    const { status } = await notify(capture);

    expect(status).toBe(200);
    expect(patchedUrls()).toEqual([expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000c3")]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000a1", subscriptionCancelledAt: null });
    expect(creditRows()).toEqual([expect.objectContaining({ action: "extended", note: "replaced 00000000-0000-4000-8000-0000000000c3" })]);
  });

  it("should clear the cancellation without stopping the old subscription again when a cancelled lapsed member rejoins", async () => {
    // Cancel already PATCHed the old subscription inactive before recording subscriptionCancelledAt.
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: new Date(Date.now() - 60 * 86_400_000),
    });
    stubEasypayRoutes(paidSubscription());

    await notify(capture);

    expect(patchedUrls()).toEqual([]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000a1", subscriptionCancelledAt: null });
  });

  it("should extend access but keep the stored id when a capture arrives for an already-replaced subscription", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null,
    });
    selectReturns = [{ id: 3 }]; // ledger: sub-abc was replaced by sub-new
    stubEasypayRoutes(paidSubscription());

    const { status } = await notify(capture);

    expect(status).toBe(200);
    const set = usersUpdate()!;
    expect(set.subscriptionExpiresAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty("easypaySubscriptionId");
    expect(set).not.toHaveProperty("subscriptionCancelledAt");
    // It should not be charging at all: try once more to stop it.
    expect(patchedUrls()).toEqual([expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000a1")]);
    expect(creditRows()).toEqual([expect.objectContaining({ action: "extended", note: "capture on replaced 00000000-0000-4000-8000-0000000000a1" })]);
  });

  it("should still extend access and record the failure when the old subscription cannot be stopped on a capture", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(paidSubscription(), { patchOk: false });

    const { status } = await notify(capture);

    expect(status).toBe(200);
    expect(deleteCalls).toEqual([]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000a1", subscriptionCancelledAt: null });
    expect(creditRows()).toEqual([expect.objectContaining({ action: "extended", note: "replaced 00000000-0000-4000-8000-0000000000c3; deactivation failed" })]);
  });

  it("should release the claim and answer 503 when the old subscription cannot be stopped on subscription_create", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }), { patchOk: false });

    const { status } = await notify({ id: "00000000-0000-4000-8000-0000000000b2", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" });

    expect(status).toBe(503);
    expect(deleteCalls).toEqual([paymentTransactions]);
    expect(usersUpdate()).toBeNull();
  });

  it("should not adopt an already-replaced subscription when its subscription_create arrives late", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null,
    });
    selectReturns = [{ id: 3 }];
    stubEasypayRoutes(freshSubscription({ id: "00000000-0000-4000-8000-0000000000a1" }));

    const { status } = await notify({ id: "00000000-0000-4000-8000-0000000000a1", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" });

    expect(status).toBe(200);
    expect(usersUpdate()).toBeNull();
    expect(ledgerUpdate()).toMatchObject({ action: "ignored", note: "create on replaced 00000000-0000-4000-8000-0000000000a1" });
  });

  describe("a replacement subscription_create (E1-E3)", () => {
    const withAccess = (overrides: Record<string, any> = {}) => ({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null, ...overrides,
    });
    const INACTIVE = '{"status":"inactive"}';

    it("should treat a 404 from the deactivation as already stopped and adopt the new subscription", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: 404 });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(deleteCalls).toEqual([]);
      expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null });
      expect(ledgerUpdate()).toMatchObject({ action: "method_updated", note: "replaced 00000000-0000-4000-8000-0000000000c3; deactivation: already inactive" });
    });

    it("should remember an already-inactive replaced subscription so its late notifications are stale", async () => {
      // The note written above must be one wasReplaced recognises, or a late capture on
      // sub-old would swap it back in.
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2" }));
      selectResolver = ({ params }) =>
        params.includes("replaced 00000000-0000-4000-8000-0000000000c3; deactivation: already inactive") ? [{ id: 3 }] : [];
      stubEasypayById({ "00000000-0000-4000-8000-0000000000c3": paidSubscription({ id: "00000000-0000-4000-8000-0000000000c3" }) });

      const { status } = await notify({ ...capture, id: "00000000-0000-4000-8000-0000000000c3" });

      expect(status).toBe(200);
      expect(usersUpdate()).not.toHaveProperty("easypaySubscriptionId");
      expect(creditRows()).toEqual([expect.objectContaining({ note: "capture on replaced 00000000-0000-4000-8000-0000000000c3" })]);
    });

    it.each([[400], [401], [409], [422]])(
      "should treat an HTTP %i from the deactivation as a failure to retry, not as stopped",
      async (code) => {
        (db.query.users.findFirst as any).mockResolvedValue(withAccess());
        stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: code });
        const { status } = await notify(create);
        expect(status).toBe(503);
        expect(deleteCalls).toEqual([paymentTransactions]);
        expect(usersUpdate()).toBeNull();
      },
    );

    it("should treat a 403 from the deactivation as a failure, not as already stopped", async () => {
      // Stopping an already inactive subscription answers "ok" at Easypay, so a 403 (bad
      // credentials) says nothing about the old card: it must be retried, not assumed stopped.
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: 403 });
      const { status } = await notify(create);
      expect(status).toBe(503);
      expect(deleteCalls).toEqual([paymentTransactions]);
      expect(usersUpdate()).toBeNull();
    });

    it("should still release the claim and answer 503 when the deactivation gets a 500", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: 500 });
      const { status } = await notify(create);
      expect(status).toBe(503);
      expect(deleteCalls).toEqual([paymentTransactions]);
      expect(usersUpdate()).toBeNull();
    });

    it("should release the claim and answer 503 when the deactivation hits a network error", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: "network" });
      const { status } = await notify(create);
      expect(status).toBe(503);
      expect(deleteCalls).toEqual([paymentTransactions]);
      expect(usersUpdate()).toBeNull();
    });

    it("should deactivate the new subscription and keep the cancellation when a cancelled member's card update completes", async () => {
      const cancelledAt = new Date(Date.now() - 86_400_000);
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ subscriptionCancelledAt: cancelledAt }));
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(patchBodies()).toEqual([[expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000b2"), INACTIVE]]);
      expect(usersUpdate()).toBeNull();
      expect(ledgerUpdate()).toMatchObject({ action: "replacement_cancelled" });
    });

    it("should release the claim and answer 503 when the new subscription of a cancelled member cannot be stopped", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ subscriptionCancelledAt: new Date() }));
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) }, { patchStatus: 500 });
      const { status } = await notify(create);
      expect(status).toBe(503);
      expect(deleteCalls).toEqual([paymentTransactions]);
      expect(usersUpdate()).toBeNull();
    });

    it("should still adopt the new subscription when a cancelled member whose access has ended joins again", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        withAccess({ subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000), subscriptionCancelledAt: new Date(Date.now() - 60 * 86_400_000) }),
      );
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": freshSubscription({ id: "00000000-0000-4000-8000-0000000000b2" }) });
      const { status } = await notify(create);
      expect(status).toBe(200);
      expect(patchBodies()).toEqual([]);
      expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2", subscriptionCancelledAt: null });
    });

    it("should extend access but keep the id and cancellation when a capture lands on a replacement for a cancelled member", async () => {
      const cancelledAt = new Date(Date.now() - 86_400_000);
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ subscriptionCancelledAt: cancelledAt }));
      stubEasypayById({ "00000000-0000-4000-8000-0000000000a1": paidSubscription() });
      const { status } = await notify(capture);
      expect(status).toBe(200);
      expect(patchBodies()).toEqual([[expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000a1"), INACTIVE]]);
      const set = usersUpdate()!;
      expect(set.subscriptionExpiresAt).toBeInstanceOf(Date);
      expect(set).not.toHaveProperty("easypaySubscriptionId");
      expect(set).not.toHaveProperty("subscriptionCancelledAt");
    });

    it("should adopt the incoming subscription and stop the stored one when the incoming one is newer", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        "00000000-0000-4000-8000-0000000000c3": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000c3", created_at: easypayAgo(240) }),
        "00000000-0000-4000-8000-0000000000b2": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000b2", created_at: easypayAgo(1) }),
      });
      const { status } = await notify(create);
      expect(status).toBe(200);
      expect(patchBodies()).toEqual([[expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000c3"), INACTIVE]]);
      expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2" });
      expect(ledgerUpdate()).toMatchObject({ action: "method_updated" });
    });

    it("should deactivate the incoming subscription and keep the stored one when the incoming one is older", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        "00000000-0000-4000-8000-0000000000c3": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000c3", created_at: easypayAgo(1) }),
        "00000000-0000-4000-8000-0000000000b2": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000b2", created_at: easypayAgo(240) }),
      });
      const { status } = await notify(create);
      expect(status).toBe(200);
      expect(patchBodies()).toEqual([[expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000b2"), INACTIVE]]);
      expect(usersUpdate()).toBeNull();
      expect(ledgerUpdate()).toMatchObject({ action: "stale_replacement" });
    });

    it("should release the claim and answer 503 when an older incoming subscription cannot be stopped", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        "00000000-0000-4000-8000-0000000000c3": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000c3", created_at: easypayAgo(1) }),
        "00000000-0000-4000-8000-0000000000b2": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000b2", created_at: easypayAgo(240) }),
      }, { patchStatus: 500 });
      const { status } = await notify(create);
      expect(status).toBe(503);
      // It is the incoming (older) one that failed to stop, not the stored one.
      expect(patchBodies().map(([url]) => url)).toEqual([expect.stringContaining("/subscription/00000000-0000-4000-8000-0000000000b2")]);
      expect(deleteCalls).toEqual([paymentTransactions]);
    });

    it("should adopt the incoming subscription when the stored one is gone at Easypay (404)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ "00000000-0000-4000-8000-0000000000b2": easypaySubscription({ id: "00000000-0000-4000-8000-0000000000b2", created_at: easypayAgo(240) }) });
      const { status } = await notify(create);
      expect(status).toBe(200);
      expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "00000000-0000-4000-8000-0000000000b2" });
    });
  });

  describe("a forged or replayed subscription_create (adoption follows Easypay's own record)", () => {
    const withAccess = (overrides: Record<string, any> = {}) => ({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "00000000-0000-4000-8000-0000000000c3", subscriptionCancelledAt: null, ...overrides,
    });
    const B2 = "00000000-0000-4000-8000-0000000000b2";
    const C3 = "00000000-0000-4000-8000-0000000000c3";

    it("should neither stop nor swap anything when the subscription was created long ago", async () => {
      // The victim's own older subscription, read back from Easypay: a real create would
      // have been sent when it was created, a month ago, not now.
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        [C3]: easypaySubscription({ id: C3, created_at: easypayAgo(40 * 24 * 60) }),
        [B2]: easypaySubscription({ id: B2, created_at: easypayAgo(30 * 24 * 60) }),
      });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
      expect(ledgerUpdate()).toMatchObject({ action: "create_not_adopted" });
    });

    it("should neither stop nor swap anything when Easypay reports the subscription's method inactive", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        [C3]: easypaySubscription({ id: C3, created_at: easypayAgo(120) }),
        [B2]: easypaySubscription({ id: B2, created_at: easypayAgo(1), method: { type: "CC", status: "inactive" } }),
      });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
      expect(ledgerUpdate()).toMatchObject({ action: "create_not_adopted" });
    });

    it("should neither stop nor swap anything when Easypay gives no creation date", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({ [C3]: easypaySubscription({ id: C3, created_at: easypayAgo(120) }), [B2]: easypaySubscription({ id: B2 }) });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
    });

    it("should not stop the new subscription of a cancelled member when it was created long ago", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ subscriptionCancelledAt: new Date(Date.now() - 86_400_000) }));
      stubEasypayById({ [B2]: easypaySubscription({ id: B2, created_at: easypayAgo(30 * 24 * 60) }) });

      await notify(create);

      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
    });

    it("should not store an old subscription for a member who has none", async () => {
      stubEasypayById({ [B2]: easypaySubscription({ id: B2, created_at: easypayAgo(30 * 24 * 60) }) });

      await notify(create);

      expect(usersUpdate()).toBeNull();
      expect(ledgerUpdate()).toMatchObject({ action: "create_not_adopted" });
    });

    it("should not stop a replaced subscription again on a replay of its old create", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess({ easypaySubscriptionId: B2 }));
      selectReturns = [{ id: 3 }];
      stubEasypayById({ [C3]: easypaySubscription({ id: C3, created_at: easypayAgo(30 * 24 * 60) }) });

      await notify({ ...create, id: C3 });

      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
    });

    it("should release the claim and answer 503, stopping nothing, when the stored subscription cannot be read", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayPaths({
        [`/subscription/${B2}`]: easypaySubscription({ id: B2, created_at: easypayAgo(1) }),
        [`/subscription/${C3}`]: { httpStatus: 500 },
      });

      const { status } = await notify(create);

      expect(status).toBe(503);
      expect(patchedUrls()).toEqual([]);
      expect(usersUpdate()).toBeNull();
      expect(deleteCalls).toEqual([paymentTransactions]);
    });

    it("should still adopt a subscription Easypay created minutes ago (a real card update)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(withAccess());
      stubEasypayById({
        [C3]: easypaySubscription({ id: C3, created_at: easypayAgo(60 * 24 * 40) }),
        [B2]: easypaySubscription({ id: B2, created_at: easypayAgo(1) }),
      });

      const { status } = await notify(create);

      expect(status).toBe(200);
      expect(patchedUrls()).toEqual([expect.stringContaining(`/subscription/${C3}`)]);
      expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: B2, subscriptionCancelledAt: null });
      expect(ledgerUpdate()).toMatchObject({ action: "method_updated" });
    });
  });

  it("should extend a yearly member by a year", async () => {
    stubEasypay(paidSubscription({ frequency: "1Y" }));
    await notify(capture);
    const days = ((usersUpdate()!.subscriptionExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });
});

describe("the webhook credits captures Easypay reports, never the notification body", () => {
  const SUB = "00000000-0000-4000-8000-0000000000a1";
  const DAYMS = 86_400_000;

  beforeEach(() => {
    vi.clearAllMocks();
    insertReturns = [{ id: 1 }];
    updateCalls = [];
    selectReturns = [];
    selectResolver = null;
    deleteCalls = [];
    insertedValues = [];
    creditedCaptureIds = new Set();
    failUserWrite = false;
    acceptedCredits = [];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * DAYMS),
      subscriptionAmount: "5", easypaySubscriptionId: SUB, subscriptionCancelledAt: null,
    });
  });

  it("should change nothing on the user when the body says success but Easypay lists no paid capture", async () => {
    // The forgery: a member posts a capture "success" for their own subscription.
    stubEasypay(easypaySubscription({ transactions: [] }));

    const { status } = await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(status).toBe(200);
    expect(usersUpdates()).toEqual([]);
    expect(creditRows()).toEqual([]);
    expect(ledgerUpdate()).toMatchObject({ userId: 7, action: "no_new_capture" });
  });

  it("should credit nothing when the subscription has no transactions key at all", async () => {
    stubEasypay(easypaySubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(usersUpdates()).toEqual([]);
    expect(creditRows()).toEqual([]);
  });

  it("should not credit a capture Easypay lists with nothing paid", async () => {
    stubEasypay(paidSubscription({}, [paidCapture(CAPTURE_1, { values: { paid: 0, requested: 5 } })]));

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(usersUpdates()).toEqual([]);
  });

  it("should extend once when the same notification is posted twice with different dates", async () => {
    stubEasypay(paidSubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });
    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:01" });

    expect(usersUpdates().filter((u) => u.subscriptionExpiresAt)).toHaveLength(1);
    expect(creditRows()).toHaveLength(1);
  });

  it("should credit once when two notifications race for the same new capture", async () => {
    stubEasypay(paidSubscription());

    const [a, b] = await Promise.all([
      notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" }),
      notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:02" }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(usersUpdates().filter((u) => u.subscriptionExpiresAt)).toHaveLength(1);
    expect(creditRows()).toHaveLength(1);
  });

  it("should extend access by exactly one interval for one real paid capture", async () => {
    const current = new Date(Date.now() + 10 * DAYMS);
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", subscriptionStatus: "active", subscriptionExpiresAt: current,
      subscriptionAmount: "5", easypaySubscriptionId: SUB, subscriptionCancelledAt: null,
    });
    stubEasypay(paidSubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    const expected = new Date(current);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(usersUpdate()!.subscriptionExpiresAt).toEqual(expected);
    expect(creditRows()).toEqual([
      expect.objectContaining({ userId: 7, notificationId: SUB, easypayTransactionId: CAPTURE_1, action: "extended", amount: "5" }),
    ]);
  });

  it("should credit every uncounted paid capture, oldest first, one interval each", async () => {
    const older = new Date(Date.now() - 40 * DAYMS).toISOString();
    stubEasypay(paidSubscription({}, [paidCapture(CAPTURE_2), paidCapture(CAPTURE_1, { date: older, created_at: older })]));

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(creditRows().map((r) => r.easypayTransactionId)).toEqual([CAPTURE_1, CAPTURE_2]);
  });

  it("should not credit again a capture already credited before this change (listed on a legacy row)", async () => {
    // A row written by the old code: no easypay_transaction_id, but the subscription it
    // stored lists the capture it was credited for.
    selectResolver = ({ params }) =>
      params.includes(SUB)
        ? [{ action: "extended", easypayTransactionId: null, createdAt: new Date(Date.now() - 30 * DAYMS), rawSubscription: paidSubscription() }]
        : [];
    stubEasypay(paidSubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(creditRows()).toEqual([]);
    expect(usersUpdates()).toEqual([]);
  });

  it("should not credit again a capture older than the last legacy credit even when no stored snapshot lists it", async () => {
    selectResolver = ({ params }) =>
      params.includes(SUB)
        ? [{ action: "extended", easypayTransactionId: null, createdAt: new Date(Date.now() - 30_000), rawSubscription: easypaySubscription() }]
        : [];
    stubEasypay(paidSubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(creditRows()).toEqual([]);
    expect(usersUpdates()).toEqual([]);
  });

  it("should neither re-credit nor swap subscriptions when the id is posted in upper case", async () => {
    // The id check accepts either case, and Easypay may resolve either; the ledger and the
    // stored subscription id hold Easypay's own (lower-case) form.
    selectResolver = ({ params }) =>
      params.includes(SUB)
        ? [{ action: "extended", easypayTransactionId: null, createdAt: new Date(Date.now() - 30 * DAYMS), rawSubscription: paidSubscription() }]
        : [];
    stubEasypayRoutes(paidSubscription());

    await notify({ id: SUB.toUpperCase(), type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(creditRows()).toEqual([]);
    expect(usersUpdates()).toEqual([]);
    expect(patchedUrls()).toEqual([]);
  });

  it("should credit a capture made after the last legacy credit", async () => {
    selectResolver = ({ params }) =>
      params.includes(SUB)
        ? [{ action: "extended", easypayTransactionId: null, createdAt: new Date(Date.now() - 30 * DAYMS), rawSubscription: easypaySubscription() }]
        : [];
    stubEasypay(paidSubscription());

    await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(creditRows()).toHaveLength(1);
  });

  it("should leave access open on a refund body for which Easypay has no refund", async () => {
    // The forgery: a member's subscription id posted as a refund.
    stubEasypayPaths({ [`/subscription/${SUB}`]: paidSubscription() });

    const { status } = await notify({ id: SUB, type: "refund", status: "success", date: "2026-11-16 10:00:00" });

    expect(status).toBe(200);
    expect(usersUpdates()).toEqual([]);
    expect(ledgerUpdate()).toMatchObject({ action: "unverified" });
  });

  it("should leave access open on a refund Easypay reports on a capture we never credited", async () => {
    const REFUND = "00000000-0000-4000-8000-0000000000f1";
    stubEasypayPaths({
      [`/refund/${REFUND}`]: { id: REFUND, status: "success", value: 5, capture: { id: CAPTURE_2, payment_id: SUB, payment_type: "subscription" } },
    });

    await notify({ id: REFUND, type: "refund", status: "success", date: "2026-11-16 10:00:00" });

    expect(usersUpdates()).toEqual([]);
    expect(ledgerUpdate()).toMatchObject({ action: "reversal_review" });
  });

  it("should close access on a successful refund of a capture we credited", async () => {
    const REFUND = "00000000-0000-4000-8000-0000000000f2";
    stubEasypayPaths({
      [`/refund/${REFUND}`]: { id: REFUND, status: "success", value: 5, capture: { id: CAPTURE_1, payment_id: SUB, payment_type: "subscription" } },
    });
    selectResolver = ({ params }) =>
      params.includes(CAPTURE_1)
        ? [{ id: 40, userId: 7, notificationId: SUB, action: "extended", easypayTransactionId: CAPTURE_1, createdAt: new Date(), rawSubscription: null }]
        : [];

    await notify({ id: REFUND, type: "refund", status: "success", date: "2026-11-16 10:00:00" });

    expect(usersUpdate()).toMatchObject({ subscriptionStatus: "expired" });
    expect(ledgerUpdate()).toMatchObject({ userId: 7, action: "reversed" });
  });

  it("should leave access open while Easypay reports the refund as still pending", async () => {
    const REFUND = "00000000-0000-4000-8000-0000000000f3";
    stubEasypayPaths({
      [`/refund/${REFUND}`]: { id: REFUND, status: "pending", value: 5, capture: { id: CAPTURE_1, payment_id: SUB } },
    });
    selectResolver = ({ params }) =>
      params.includes(CAPTURE_1)
        ? [{ id: 40, userId: 7, notificationId: SUB, action: "extended", easypayTransactionId: CAPTURE_1, createdAt: new Date(), rawSubscription: null }]
        : [];

    await notify({ id: REFUND, type: "refund", status: "success", date: "2026-11-16 10:00:00" });

    expect(usersUpdates()).toEqual([]);
  });

  it("should answer 503 and give the claim back when Easypay answers 500 to the subscription read", async () => {
    stubEasypayPaths({ [`/subscription/${SUB}`]: { httpStatus: 500 } });

    const { status, body } = await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(status).toBe(503);
    expect(body).toEqual({ received: false, retry: true });
    expect(deleteCalls).toEqual([paymentTransactions]);
    expect(usersUpdates()).toEqual([]);
  });

  it("should answer 503 and give the claim back when a database write fails after the claim", async () => {
    stubEasypay(paidSubscription());
    failUserWrite = true;

    const { status } = await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(status).toBe(503);
    expect(deleteCalls).toEqual([paymentTransactions]);
  });

  it("should record a 404 on a capture notification for a human and answer 200 so Easypay does not loop", async () => {
    stubEasypayPaths({});

    const { status } = await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });

    expect(status).toBe(200);
    expect(deleteCalls).toEqual([]);
    expect(ledgerUpdate()).toMatchObject({ action: "unverified", note: expect.stringContaining("404") });
  });

  describe("reconcile job", () => {
    it("should not count again a capture the webhook already credited", async () => {
      const { reconcileMemberships } = await import("../../src/services/membership-reconcile.ts");
      stubEasypay(paidSubscription());
      await notify({ id: SUB, type: "subscription_capture", status: "success", date: "2026-11-16 10:00:00" });
      expect(creditRows()).toHaveLength(1);
      // From here the ledger answers like Postgres would: the member list, and the credit row.
      selectResolver = ({ sql }) =>
        sql.includes('"users"')
          ? [{ id: 7, easypaySubscriptionId: SUB }]
          : creditRows().map((r) => ({ ...r, createdAt: new Date() }));

      const result = await reconcileMemberships();

      expect(result.credited).toBe(0);
      expect(creditRows()).toHaveLength(1);
      expect(usersUpdates().filter((u) => u.subscriptionExpiresAt)).toHaveLength(1);
    });

    it("should credit a paid capture whose notification never arrived", async () => {
      const { reconcileMemberships } = await import("../../src/services/membership-reconcile.ts");
      stubEasypay(paidSubscription());
      selectResolver = ({ sql }) => (sql.includes('"users"') ? [{ id: 7, easypaySubscriptionId: SUB }] : []);

      const result = await reconcileMemberships();

      expect(result.credited).toBe(1);
      expect(creditRows()).toEqual([expect.objectContaining({ userId: 7, easypayTransactionId: CAPTURE_1 })]);
    });

    it("should credit nothing from a subscription Easypay attributes to another user", async () => {
      const { reconcileMemberships } = await import("../../src/services/membership-reconcile.ts");
      stubEasypay(paidSubscription({ customer: { key: "user-8" } }));
      selectResolver = ({ sql }) => (sql.includes('"users"') ? [{ id: 7, easypaySubscriptionId: SUB }] : []);

      const result = await reconcileMemberships();

      expect(result.credited).toBe(0);
      expect(creditRows()).toEqual([]);
    });
  });
});

describe("membership emails from the webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturns = [{ id: 1 }];
    updateCalls = [];
    selectReturns = [];
    selectResolver = null;
    deleteCalls = [];
    insertedValues = [];
    creditedCaptureIds = new Set();
    failUserWrite = false;
    acceptedCredits = [];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "pt",
      subscriptionStatus: "none", subscriptionExpiresAt: null, subscriptionAmount: null,
    });
    (sendEmail as any).mockImplementation(() => Promise.resolve());
  });

  it("should send one welcome email on first activation", async () => {
    stubEasypay(paidSubscription({ value: 12 }));
    await notify(capture);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as any).mock.calls[0][0];
    expect(arg.to).toBe("member@test.com");
    expect(arg.subject).toBe("Bem-vindo à Padmakara");
    expect(arg.html).toContain("€12");
  });

  it("should not send an email when the payment only extends access", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 5 * 86_400_000), subscriptionAmount: "5",
    });
    stubEasypay(paidSubscription());
    await notify(capture);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should send a payment-failed email with the grace date on a failed capture", async () => {
    const expiry = new Date(Date.now() + 2 * 86_400_000);
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: expiry, subscriptionAmount: "5",
    });
    stubEasypay(easypaySubscription());
    await notify({ ...capture, status: "failed" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as any).mock.calls[0][0];
    expect(arg.subject).toBe("We couldn't take your Padmakara donation");
    const grace = new Date(expiry);
    grace.setDate(grace.getDate() + 7);
    const expected = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(grace);
    expect(arg.html).toContain(expected);
  });

  it("should not send a payment-failed email when access has already ended", async () => {
    // A renewal of a subscription that was paid before keeps failing after the grace period.
    selectReturns = [{ id: 1, action: "extended", note: null }];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000), subscriptionAmount: "5",
    });
    stubEasypay(easypaySubscription());
    await notify({ ...capture, status: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should welcome a lapsed member whose stored status still reads active when they rejoin", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000), subscriptionAmount: "5",
    });
    stubEasypay(paidSubscription());
    await notify(capture);
    expect(creditRows()).toEqual([expect.objectContaining({ action: "activated" })]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("should send the first-payment-failed email once, and not the renewal one, when there is no expiry date", async () => {
    stubEasypay(easypaySubscription());
    await notify({ ...capture, status: "failed" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as any).mock.calls[0][0];
    expect(arg.to).toBe("member@test.com");
    expect(arg.subject).toBe("O seu pagamento Padmakara não foi concluído");
    expect(arg.html).toContain("/membership");
  });

  it("should send the first-payment-failed email to a lapsed member whose rejoin payment fails", async () => {
    // Their old expiry date is in the past: no access, so this is a first payment again.
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
      subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000), subscriptionAmount: "5",
    });
    stubEasypay(easypaySubscription());
    await notify({ ...capture, status: "failed" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail as any).mock.calls[0][0].subject).toBe("Your Padmakara payment didn't go through");
  });

  it("should not send the first-payment-failed email for a failed subscription_create", async () => {
    stubEasypay(easypaySubscription());
    await notify({ ...capture, type: "subscription_create", status: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  describe("one failure email per failure, not per Easypay retry (E6)", () => {
    const DAYMS = 86_400_000;
    /**
     * A ledger that answers the dedupe lookup the way Postgres would: the current row (id 1)
     * and one earlier `payment_failed` row for sub-abc, filtered by the query's own
     * notification id, note, cutoff date and "not this row" condition.
     */
    function ledgerWithEarlierFailure(daysAgo: number | null) {
      const rows = [
        { id: 1, notificationId: "00000000-0000-4000-8000-0000000000a1", note: "payment_failed", createdAt: new Date() },
        ...(daysAgo === null ? [] : [{ id: 99, notificationId: "00000000-0000-4000-8000-0000000000a1", note: "payment_failed", createdAt: new Date(Date.now() - daysAgo * DAYMS) }]),
      ];
      selectResolver = ({ sql, params }) => {
        if (!params.includes("payment_failed")) return [];
        const cutoffRaw = params.find((p) => p instanceof Date || (typeof p === "string" && /^\d{4}-\d\d-\d\dT/.test(p)));
        const cutoff = cutoffRaw === undefined ? null : new Date(cutoffRaw as string | Date);
        return rows.filter(
          (r) =>
            params.includes(r.notificationId) &&
            (cutoff === null || r.createdAt >= cutoff) &&
            !(/<>/.test(sql) && params.includes(r.id)),
        );
      };
    }
    const renewalMember = () =>
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
        subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 2 * DAYMS), subscriptionAmount: "5",
      });
    const failedNotification = { ...capture, status: "failed" };

    it("should send the renewal email on the first failure", async () => {
      renewalMember();
      ledgerWithEarlierFailure(null);
      stubEasypay(easypaySubscription());
      await notify(failedNotification);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("should not send a second renewal email when the same subscription failed again within 7 days", async () => {
      renewalMember();
      ledgerWithEarlierFailure(2);
      stubEasypay(easypaySubscription());
      const { status } = await notify(failedNotification);
      expect(status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(ledgerUpdate()).toMatchObject({ action: "ignored", note: "payment_failed" });
    });

    it("should send the renewal email again when the earlier failure was 8 days ago", async () => {
      renewalMember();
      ledgerWithEarlierFailure(8);
      stubEasypay(easypaySubscription());
      await notify(failedNotification);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("should not send a second first-payment-failed email within 7 days", async () => {
      // default member: no access, subscription never paid
      ledgerWithEarlierFailure(1);
      stubEasypay(easypaySubscription());
      await notify(failedNotification);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("should send the first-payment-failed email again after 8 days", async () => {
      ledgerWithEarlierFailure(8);
      stubEasypay(easypaySubscription());
      await notify(failedNotification);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  it("should not send an email for an unrecognised notification type", async () => {
    stubEasypay(easypaySubscription());
    await notify({ ...capture, type: "something-new" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should still answer 200 when the mail fails", async () => {
    (sendEmail as any).mockImplementation(() => Promise.reject(new Error("SES down")));
    stubEasypay(paidSubscription());
    const { status, body } = await notify(capture);
    expect(status).toBe(200);
    expect(body.received).toBe(true);
  });

  it("should still answer 200 when the mail throws synchronously", async () => {
    (sendEmail as any).mockImplementation(() => { throw new Error("boom"); });
    stubEasypay(paidSubscription());
    const { status } = await notify(capture);
    expect(status).toBe(200);
  });
});

describe("POST /api/payment/subscribe (real Easypay)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    selectReturns = [];
    insertedValues = [];
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
    expect(sent.payment.capture.descriptive).toBe("Donativo Padmakara");
    const start = new Date(sent.payment.start_time.replace(" ", "T") + ":00Z");
    const daysOut = (start.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(27);
    expect(daysOut).toBeLessThan(32);
  });

  it.each([
    ["pt", "month", "Donativo mensal Padmakara"],
    ["pt", "year", "Donativo anual Padmakara"],
    ["en", "month", "Padmakara donation (monthly)"],
    ["en", "year", "Padmakara donation (yearly)"],
  ])("should name the %s %s payment a donation on the Easypay form", async (language, interval, label) => {
    const amount = interval === "year" ? 60 : 10;
    await testJson("/api/payment/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount, interval, language }),
    });
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.order.items[0].description).toBe(label);
  });

  it("should record a checkout_created ledger row after creating the checkout", async () => {
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month" }),
    });
    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      userId: 5, notificationId: "chk-1", notificationType: "checkout", notificationStatus: null,
      dedupeKey: "checkout:chk-1", action: "checkout_created", amount: "10", currency: "EUR",
      rawPayload: { checkoutId: "chk-1", amount: 10, interval: "month" },
    });
  });

  it("should answer 409 MEMBERSHIP_PROCESSING without creating a new checkout while a Direct Debit is pending", async () => {
    selectReturns = [
      { notificationType: "checkout", notificationId: "chk-0", action: "checkout_created", note: null, amount: "10", createdAt: new Date(Date.now() - 86_400_000) },
    ];
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ payment: { status: "pending" }, method: { type: "dd" } }) } as unknown as Response),
    );
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month" }),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MEMBERSHIP_PROCESSING");
    expect(JSON.stringify(res.body)).toContain("Your first payment is still being processed.");
    const urls = fetchMock.mock.calls.map((c: any[]) => c[0] as string);
    expect(urls.some((u) => u.endsWith("/checkout"))).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });

  it("should still create a checkout when the pending checkout was a card", async () => {
    selectReturns = [
      { notificationType: "checkout", notificationId: "chk-0", action: "checkout_created", note: null, amount: "10", createdAt: new Date(Date.now() - 86_400_000) },
    ];
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url.endsWith("/chk-0") ? { payment: { status: "pending" }, method: { type: "cc" } } : { id: "chk-1", session: "sess" }),
      } as unknown as Response),
    );
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month" }),
    });
    expect(res.status).toBe(200);
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

  it("should return the checkout manifest and the testing flag so the app can embed the form", async () => {
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month" }),
    });
    expect(res.body.checkout).toEqual({ id: expect.any(String), session: expect.any(String) });
    expect(res.body.checkout.id.length).toBeGreaterThan(0);
    expect(res.body.checkout.session.length).toBeGreaterThan(0);
    expect(res.body.testing).toBe(config.easypay.testing);
  });
});
