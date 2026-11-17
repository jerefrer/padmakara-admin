import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Refunds and chargebacks of membership captures (User decision, 2026-11-17).
 *
 * A refund takes back what that one capture paid for: one interval off the paid-through
 * date, never before the capture's own date. A chargeback ends the relationship: access
 * closes now and the subscription is stopped at Easypay; if the stop fails, nothing is
 * applied and Easypay is asked to retry.
 *
 * The database stand-in keeps the member and the ledger in memory and runs each
 * transaction on a copy, committed only when the callback resolves, so a failure halfway
 * leaves nothing behind exactly as a rolled-back Postgres transaction would.
 */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

const SUB = "00000000-0000-4000-8000-0000000000a1";
const OLD_SUB = "00000000-0000-4000-8000-0000000000a0";
const CAPTURE_1 = "00000000-0000-4000-8000-00000000c001";
const REFUND = "00000000-0000-4000-8000-0000000000f1";
const CHARGEBACK = "00000000-0000-4000-8000-0000000000cb";
const DAY = 86_400_000;

interface LedgerRow {
  id: number;
  userId: number | null;
  notificationId: string;
  action: string;
  note: string | null;
  easypayTransactionId: string | null;
  rawSubscription: unknown;
  createdAt: Date;
  [key: string]: unknown;
}

const state = {
  member: null as Record<string, any> | null,
  ledger: [] as LedgerRow[],
  /** Every committed users write, in order. */
  userWrites: [] as Array<Record<string, any>>,
  nextId: 1,
};

vi.mock("../../src/db/index.ts", async () => {
  const { users } = await import("../../src/db/schema/users.ts");
  const { paymentTransactions } = await import("../../src/db/schema/payment-transactions.ts");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const render = (cond: any) => (cond ? dialect.sqlToQuery(cond) : { sql: "", params: [] as unknown[] });

  /** Ledger lookups, answered from the in-memory ledger by what the WHERE clause asks. */
  const ledgerRows = (ledger: LedgerRow[], cond: any): LedgerRow[] => {
    const { sql, params } = render(cond);
    const lower = params.map((p) => (typeof p === "string" ? p.toLowerCase() : p));
    // verifyReversal: the credit row of a capture id.
    const byCapture = ledger.filter((r) => r.easypayTransactionId && lower.includes(r.easypayTransactionId.toLowerCase()));
    if (byCapture.length) return byCapture;
    // Rows about one notification id with one of the listed actions, other than a given id.
    if (sql.includes('"action" in')) {
      return ledger.filter(
        (r) =>
          lower.includes(r.notificationId.toLowerCase()) &&
          params.includes(r.action) &&
          !(sql.includes('"id" <>') && params.includes(r.id)),
      );
    }
    return [];
  };

  const makeDb = (store: { member: Record<string, any> | null; ledger: LedgerRow[]; userWrites: Array<Record<string, any>> }) => {
    const db: Record<string, any> = {
      query: { users: { findFirst: vi.fn(async () => (store.member ? { ...store.member } : null)) } },
      insert: vi.fn(() => ({
        values: (v: Record<string, any>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (store.ledger.some((r) => r.dedupeKey === v.dedupeKey)) return [];
              const row = { id: state.nextId++, userId: null, note: null, easypayTransactionId: null, rawSubscription: null, createdAt: new Date(), ...v } as LedgerRow;
              store.ledger.push(row);
              return [{ id: row.id }];
            },
          }),
        }),
      })),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: (cond: any) => {
            const rows = () => (table === users ? (store.member ? [{ ...store.member }] : []) : ledgerRows(store.ledger, cond));
            return {
              limit: async () => rows(),
              orderBy: () => ({ limit: async () => rows() }),
              for: async () => rows(),
            };
          },
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: (v: Record<string, any>) => ({
          where: async (cond: any) => {
            if (table === users) {
              if (store.member) Object.assign(store.member, v);
              store.userWrites.push(v);
              return;
            }
            const id = render(cond).params[0];
            const row = store.ledger.find((r) => r.id === id);
            if (row) Object.assign(row, v);
          },
        }),
      })),
      delete: vi.fn(() => ({
        where: async (cond: any) => {
          const id = render(cond).params[0];
          const i = store.ledger.findIndex((r) => r.id === id);
          if (i >= 0) store.ledger.splice(i, 1);
        },
      })),
    };
    return db;
  };

  // Reads through to `state`, which each test replaces in beforeEach.
  const live = {
    get member() { return state.member; },
    set member(m) { state.member = m; },
    get ledger() { return state.ledger; },
    get userWrites() { return state.userWrites; },
  };
  const db = makeDb(live);
  db.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => {
    const copy = {
      member: state.member ? { ...state.member } : null,
      ledger: state.ledger.map((r) => ({ ...r })),
      userWrites: [] as Array<Record<string, any>>,
    };
    const result = await cb(makeDb(copy));
    // Commit.
    state.member = copy.member;
    state.ledger.splice(0, state.ledger.length, ...copy.ledger);
    state.userWrites.push(...copy.userWrites);
    return result;
  });
  return { db };
});
vi.mock("../../src/services/email.ts", () => ({ sendEmail: vi.fn(async () => {}) }));

import { testJson } from "../helpers.ts";

/**
 * Easypay stand-in: GET answers by path after `/2.0` (404 for an unknown path), PATCH
 * answers `patchStatus` (a number, or "network" for a dropped connection).
 */
function stubEasypay(routes: Record<string, any>, { patchStatus = 200 as number | "network" } = {}) {
  const fn = vi.fn((url: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") === "PATCH") {
      if (patchStatus === "network") return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve({
        ok: patchStatus < 400, status: patchStatus,
        json: () => Promise.resolve({}), text: () => Promise.resolve("{}"),
      } as unknown as Response);
    }
    const hit = routes[url.replace(/^.*\/2\.0/, "")];
    const status = hit === undefined ? 404 : 200;
    return Promise.resolve({
      ok: status < 400, status,
      json: () => Promise.resolve(hit ?? {}), text: () => Promise.resolve(JSON.stringify(hit ?? {})),
    } as unknown as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const patched = () =>
  ((global.fetch as any).mock.calls as any[][])
    .filter((c) => c[1]?.method === "PATCH")
    .map((c) => [String(c[0]).replace(/^.*\/2\.0/, ""), c[1].body]);

const notify = (id: string, type: "refund" | "chargeback", date = "2026-11-17 10:00:00") =>
  testJson("/api/payment/webhook", {
    method: "POST",
    body: JSON.stringify({ id, key: "", type, status: "success", date }),
  });

/** A credit row for CAPTURE_1 on `subscriptionId`, its snapshot listing the capture at `capturedAt`. */
function creditRow({ frequency = "1M", capturedAt = new Date(Date.now() - 2 * DAY), subscriptionId = SUB } = {}): LedgerRow {
  const at = capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    id: state.nextId++, userId: 7, notificationId: subscriptionId, action: "extended", note: null,
    easypayTransactionId: CAPTURE_1, dedupeKey: `capture:${CAPTURE_1}`, createdAt: capturedAt,
    rawSubscription: {
      id: subscriptionId, frequency, value: 5, customer: { key: "user-7" },
      transactions: [{ id: CAPTURE_1, date: at, created_at: at, values: { paid: 5, requested: 5 } }],
    },
  };
}

const refund = { id: REFUND, status: "success", value: 5, capture: { id: CAPTURE_1, payment_id: SUB, payment_type: "SUBSCRIPTION" } };
const chargeback = { id: CHARGEBACK, code: "MD06", amount: 5, capture: { id: CAPTURE_1, payment_id: SUB, payment_type: "SUBSCRIPTION" } };

/** The ledger row of the notification about `id` (the claim, with its outcome). */
const outcomeOf = (id: string) => state.ledger.filter((r) => r.notificationId === id);

/** One calendar month (or year) earlier in UTC, as the policy counts it. */
function minus(d: Date, interval: "month" | "year"): Date {
  const out = new Date(d);
  if (interval === "year") out.setUTCFullYear(out.getUTCFullYear() - 1);
  else out.setUTCMonth(out.getUTCMonth() - 1);
  return out;
}

/** A paid-through date on the 15th, so calendar subtraction has no month-end clamping. */
function on15th(monthsAhead: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsAhead, 15, 12, 0, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ledger = [];
  state.userWrites = [];
  state.nextId = 1;
  state.member = {
    id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "en",
    subscriptionStatus: "active", subscriptionSource: "easypay", subscriptionExpiresAt: on15th(3),
    subscriptionAmount: "5", easypaySubscriptionId: SUB, subscriptionCancelledAt: null,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/payment/webhook: refund of a membership capture", () => {
  it("should remove one month and keep access open when a monthly refund leaves the date in the future", async () => {
    const paidThrough = on15th(3);
    state.member!.subscriptionExpiresAt = paidThrough;
    state.ledger.push(creditRow({ frequency: "1M" }));
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    const { status } = await notify(REFUND, "refund");

    expect(status).toBe(200);
    expect(state.member!.subscriptionExpiresAt).toEqual(minus(paidThrough, "month"));
    expect(state.member!.subscriptionStatus).toBe("active");
    expect(patched()).toEqual([]);
    const [row] = outcomeOf(REFUND);
    expect(row).toMatchObject({ userId: 7, action: "refund_interval_removed", amount: "5" });
    expect(row!.note).toContain(CAPTURE_1);
    expect(row!.note).toContain(paidThrough.toISOString());
    expect(row!.note).toContain(minus(paidThrough, "month").toISOString());
  });

  it("should remove one year when the refunded capture was of a yearly subscription", async () => {
    const paidThrough = on15th(15);
    state.member!.subscriptionExpiresAt = paidThrough;
    state.ledger.push(creditRow({ frequency: "1Y" }));
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund");

    expect(state.member!.subscriptionExpiresAt).toEqual(minus(paidThrough, "year"));
    expect(state.member!.subscriptionStatus).toBe("active");
  });

  it("should close access when the date after removing the interval is already past", async () => {
    // A member who joined 40 days ago and renewed 10 days ago: paid through 20 days from now.
    const paidThrough = new Date(Date.now() + 20 * DAY);
    state.member!.subscriptionExpiresAt = paidThrough;
    state.ledger.push(creditRow({ capturedAt: new Date(Date.now() - 40 * DAY) }));
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund");

    expect(state.member!.subscriptionExpiresAt).toEqual(minus(paidThrough, "month"));
    expect(state.member!.subscriptionStatus).toBe("expired");
  });

  it("should never move the date before the refunded capture's own date", async () => {
    // Paid through 10 days from now; one month back would be ~20 days ago, but the capture
    // was 3 days ago: what came before it was paid by something else.
    const capturedAt = new Date(Math.floor((Date.now() - 3 * DAY) / 1000) * 1000);
    state.member!.subscriptionExpiresAt = new Date(Date.now() + 10 * DAY);
    state.ledger.push(creditRow({ capturedAt }));
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund");

    expect(state.member!.subscriptionExpiresAt).toEqual(capturedAt);
    expect(state.member!.subscriptionStatus).toBe("expired");
  });

  it("should never move the date later than it was", async () => {
    // The paid-through date is already before the capture (an admin shortened it, say).
    const paidThrough = new Date(Date.now() - 10 * DAY);
    state.member!.subscriptionExpiresAt = paidThrough;
    state.ledger.push(creditRow({ capturedAt: new Date(Date.now() - 3 * DAY) }));
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund");

    expect(state.member!.subscriptionExpiresAt).toEqual(paidThrough);
  });

  it("should remove the interval once when the same refund is notified twice", async () => {
    const paidThrough = on15th(3);
    state.member!.subscriptionExpiresAt = paidThrough;
    state.ledger.push(creditRow());
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund", "2026-11-17 10:00:00");
    const second = await notify(REFUND, "refund", "2026-11-17 10:05:00");

    expect(second.status).toBe(200);
    expect(state.member!.subscriptionExpiresAt).toEqual(minus(paidThrough, "month"));
    expect(state.userWrites).toHaveLength(1);
    expect(outcomeOf(REFUND).map((r) => r.action).sort()).toEqual(["ignored", "refund_interval_removed"]);
  });

  it("should leave a refund Easypay reports on a capture we never credited to a human", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund });

    await notify(REFUND, "refund");

    expect(state.userWrites).toEqual([]);
    expect(outcomeOf(REFUND)[0]).toMatchObject({ action: "reversal_review" });
  });
});

describe("POST /api/payment/webhook: chargeback of a membership capture", () => {
  it("should stop the subscription at Easypay and close access now", async () => {
    state.ledger.push(creditRow());
    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback });
    const before = Date.now();

    const { status } = await notify(CHARGEBACK, "chargeback");

    expect(status).toBe(200);
    expect(patched()).toEqual([[`/subscription/${SUB}`, JSON.stringify({ status: "inactive" })]]);
    expect(state.member!.subscriptionStatus).toBe("expired");
    const until = (state.member!.subscriptionExpiresAt as Date).getTime();
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until).toBeLessThanOrEqual(Date.now());
    const [row] = outcomeOf(CHARGEBACK);
    expect(row).toMatchObject({ userId: 7, action: "chargeback_closed" });
    expect(row!.note).toContain(CAPTURE_1);
    expect(row!.note).toContain(on15th(3).toISOString());
  });

  it("should also stop the member's current subscription when the chargeback is on a replaced one", async () => {
    state.ledger.push(creditRow({ subscriptionId: OLD_SUB }));
    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: { ...chargeback, capture: { ...chargeback.capture, payment_id: OLD_SUB } } });

    await notify(CHARGEBACK, "chargeback");

    expect(patched().map(([url]) => url).sort()).toEqual([`/subscription/${OLD_SUB}`, `/subscription/${SUB}`]);
    expect(state.member!.subscriptionStatus).toBe("expired");
  });

  it("should treat a 404 from the stop as already gone and still close access", async () => {
    state.ledger.push(creditRow());
    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback }, { patchStatus: 404 });

    const { status } = await notify(CHARGEBACK, "chargeback");

    expect(status).toBe(200);
    expect(state.member!.subscriptionStatus).toBe("expired");
    expect(outcomeOf(CHARGEBACK)[0]).toMatchObject({ action: "chargeback_closed" });
  });

  it.each([500, 403, "network"] as const)(
    "should apply nothing, give the claim back and answer 503 when the stop fails (%s)",
    async (patchStatus) => {
      const paidThrough = state.member!.subscriptionExpiresAt;
      state.ledger.push(creditRow());
      stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback }, { patchStatus });

      const { status, body } = await notify(CHARGEBACK, "chargeback");

      expect(status).toBe(503);
      expect(body).toEqual({ received: false, retry: true });
      expect(state.userWrites).toEqual([]);
      expect(state.member).toMatchObject({ subscriptionStatus: "active", subscriptionExpiresAt: paidThrough });
      // The claim is gone, so Easypay's retry is processed afresh.
      expect(outcomeOf(CHARGEBACK)).toEqual([]);
    },
  );

  it("should apply the chargeback on Easypay's retry after a failed stop", async () => {
    state.ledger.push(creditRow());
    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback }, { patchStatus: 500 });
    await notify(CHARGEBACK, "chargeback");

    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback });
    const { status } = await notify(CHARGEBACK, "chargeback");

    expect(status).toBe(200);
    expect(state.member!.subscriptionStatus).toBe("expired");
    expect(outcomeOf(CHARGEBACK).map((r) => r.action)).toEqual(["chargeback_closed"]);
  });

  it("should change nothing and stop nothing when the same chargeback is notified again", async () => {
    state.ledger.push(creditRow());
    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback });
    await notify(CHARGEBACK, "chargeback", "2026-11-17 10:00:00");
    const writes = state.userWrites.length;

    stubEasypay({ [`/chargeback/${CHARGEBACK}`]: chargeback });
    const second = await notify(CHARGEBACK, "chargeback", "2026-11-17 10:05:00");

    expect(second.status).toBe(200);
    expect(patched()).toEqual([]);
    expect(state.userWrites).toHaveLength(writes);
    expect(outcomeOf(CHARGEBACK).map((r) => r.action).sort()).toEqual(["chargeback_closed", "ignored"]);
  });
});
