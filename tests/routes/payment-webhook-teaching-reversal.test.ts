import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Refunds and chargebacks of one-off teaching purchases (Easypay "single" payments).
 *
 * Same evidence rule as membership reversals: the notification body proves nothing. The
 * refund or chargeback is read back from Easypay, and acted on only when it names the
 * payment of a teaching order we recorded as paid, for the full amount.
 */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

const PAY_ID = "00000000-0000-4000-8000-0000000000d4";
const CAPTURE = "00000000-0000-4000-8000-0000000000d5";
const REFUND = "00000000-0000-4000-8000-0000000000f1";
const CHARGEBACK = "00000000-0000-4000-8000-0000000000f2";

const paidOrder = {
  id: 5, publicId: "11111111-1111-1111-1111-111111111111", eventId: 8, userId: 3, email: "buyer@example.com",
  firstName: "Ana", lastName: "Silva", language: "pt", amountCents: 1500, status: "paid",
  easypayCheckoutId: "chk-1", easypayPaymentId: PAY_ID, method: "mbw", createdAt: new Date(), paidAt: new Date(),
};

/** Teaching orders the ledger lookup by payment id finds. */
let orders: Array<Record<string, unknown>> = [];
/** What the `paid -> refunded` flip returns: empty when another request won it. */
let flipRows: Array<Record<string, unknown>> = [];
/** What deleting the order's purchase grant returns: empty when there was none. */
let grantRows: Array<Record<string, unknown>> = [];
const ledgerSets: Array<Record<string, any>> = [];
const orderSets: Array<Record<string, any>> = [];
/** Every delete: its table and the rendered WHERE clause. */
const deletes: Array<{ table: unknown; where: { sql: string; params: unknown[] } | null }> = [];

vi.mock("../../src/db/index.ts", async () => {
  const { teachingOrders, eventAccessGrants } = await import("../../src/db/schema/event-access.ts");
  const { paymentTransactions } = await import("../../src/db/schema/payment-transactions.ts");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const resolved = <T>(value: T, returning: () => Promise<unknown>) =>
    Object.assign(Promise.resolve(value), { returning });
  const db: Record<string, any> = {
    query: { users: { findFirst: vi.fn(() => Promise.resolve(null)) } },
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    })),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === teachingOrders ? orders : [];
          return { limit: () => Promise.resolve(rows), orderBy: () => ({ limit: () => Promise.resolve(rows) }) };
        },
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: Record<string, any>) => {
        if (table === paymentTransactions) ledgerSets.push(v);
        if (table === teachingOrders) orderSets.push(v);
        return { where: () => resolved(undefined, () => Promise.resolve(table === teachingOrders ? flipRows : [])) };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: (cond: any) => {
        deletes.push({ table, where: cond ? dialect.sqlToQuery(cond) : null });
        return resolved(undefined, () => Promise.resolve(table === eventAccessGrants ? grantRows : []));
      },
    })),
  };
  db.transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(db));
  return { db };
});
const bumpUserAccessVersion = vi.fn(async () => {});
vi.mock("../../src/services/sync-versions.ts", () => ({ bumpUserAccessVersion: (...a: unknown[]) => (bumpUserAccessVersion as any)(...a) }));
vi.mock("../../src/services/email.ts", () => ({ sendEmail: vi.fn(async () => {}) }));

import { testJson } from "../helpers.ts";
import { eventAccessGrants } from "../../src/db/schema/event-access.ts";
import { paymentTransactions } from "../../src/db/schema/payment-transactions.ts";

/** GET answers by path after `/2.0` (404 for an unknown path; `{ httpStatus }` answers that status). */
function stubEasypay(routes: Record<string, any>) {
  const fn = vi.fn((url: string) => {
    const hit = routes[url.replace(/^.*\/2\.0/, "")];
    const status = hit === undefined ? 404 : typeof hit.httpStatus === "number" ? hit.httpStatus : 200;
    return Promise.resolve({
      ok: status < 400, status,
      json: () => Promise.resolve(hit ?? {}), text: () => Promise.resolve(JSON.stringify(hit ?? {})),
    } as unknown as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const refund = (overrides: Record<string, any> = {}) => ({
  id: REFUND, status: "success", value: 15,
  capture: { id: CAPTURE, payment_id: PAY_ID, payment_type: "SINGLE" },
  ...overrides,
});

const notify = (id: string, type: "refund" | "chargeback") =>
  testJson("/api/payment/webhook", {
    method: "POST",
    body: JSON.stringify({ id, key: "", type, status: "success", date: "2026-11-16 10:00:00" }),
  });

const grantDeletes = () => deletes.filter((d) => d.table === eventAccessGrants);
const outcome = () => ledgerSets[ledgerSets.length - 1] ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  orders = [{ ...paidOrder }];
  flipRows = [{ userId: 3 }];
  grantRows = [{ userId: 3 }];
  ledgerSets.length = 0;
  orderSets.length = 0;
  deletes.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/payment/webhook: refunds and chargebacks of teaching purchases", () => {
  it("should mark the order refunded and remove its purchase grant on a completed full refund", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    const { status } = await notify(REFUND, "refund");

    expect(status).toBe(200);
    expect(orderSets).toEqual([{ status: "refunded" }]);
    expect(grantDeletes()).toHaveLength(1);
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(3);
    expect(outcome()).toMatchObject({ userId: 3, action: "teaching_reversed", amount: "15" });
    expect(outcome()!.note).toContain("order 5");
  });

  it("should only ever delete the purchase grant of that order, never a free or manual one", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    const where = grantDeletes()[0]!.where!;
    expect(where.sql).toMatch(/"order_id" = \$\d/);
    expect(where.sql).toMatch(/"source" = \$\d/);
    expect(where.params).toEqual(expect.arrayContaining([5, "purchase"]));
  });

  it("should reverse the order on a chargeback Easypay reports on its payment", async () => {
    stubEasypay({
      [`/chargeback/${CHARGEBACK}`]: { id: CHARGEBACK, code: "MD06", amount: 15, capture: { id: CAPTURE, payment_id: PAY_ID, payment_type: "SINGLE" } },
    });

    const { status } = await notify(CHARGEBACK, "chargeback");

    expect(status).toBe(200);
    expect(orderSets).toEqual([{ status: "refunded" }]);
    expect(grantDeletes()).toHaveLength(1);
    expect(outcome()).toMatchObject({ userId: 3, action: "teaching_reversed" });
  });

  it("should record the reversal and change nothing more when the order has no purchase grant", async () => {
    // e.g. the buyer already had a free or manual grant, which won the insert at purchase time.
    grantRows = [];
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([{ status: "refunded" }]);
    expect(bumpUserAccessVersion).not.toHaveBeenCalled();
    expect(outcome()).toMatchObject({ action: "teaching_reversed" });
    expect(outcome()!.note).toContain("no purchase grant");
  });

  it("should apply a replayed refund only once", async () => {
    orders = [{ ...paidOrder, status: "refunded" }];
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ userId: 3, action: "ignored" });
  });

  it("should remove nothing when another request flipped the order first", async () => {
    flipRows = [];
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "ignored" });
  });

  it("should leave a partial refund to a human", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund({ value: 5 }) });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "reversal_review" });
    expect(outcome()!.note).toContain("partial");
  });

  it("should change nothing while Easypay reports the refund pending", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund({ status: "pending" }) });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "ignored" });
  });

  it("should change nothing when Easypay does not know the refund", async () => {
    stubEasypay({});

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "unverified" });
  });

  it("should leave a refund on a payment no teaching order of ours made to a human", async () => {
    orders = [];
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "reversal_review" });
  });

  it("should leave a refund on an order we never recorded as paid to a human", async () => {
    orders = [{ ...paidOrder, status: "pending" }];
    stubEasypay({ [`/refund/${REFUND}`]: refund() });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "reversal_review" });
  });

  it("should not treat a subscription refund as a teaching refund, whatever its payment id", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: refund({ capture: { id: CAPTURE, payment_id: PAY_ID, payment_type: "SUBSCRIPTION" } }) });

    await notify(REFUND, "refund");

    expect(orderSets).toEqual([]);
    expect(grantDeletes()).toEqual([]);
    expect(outcome()).toMatchObject({ action: "reversal_review" });
  });

  it("should release the claim and answer 503 when Easypay cannot be read", async () => {
    stubEasypay({ [`/refund/${REFUND}`]: { httpStatus: 502 } });

    const { status } = await notify(REFUND, "refund");

    expect(status).toBe(503);
    expect(deletes.map((d) => d.table)).toEqual([paymentTransactions]);
    expect(orderSets).toEqual([]);
  });
});
