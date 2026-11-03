import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

const PUBLIC_ID = "11111111-1111-1111-1111-111111111111";
const order = {
  id: 5, publicId: PUBLIC_ID, eventId: 8, userId: 3, email: "buyer@example.com", firstName: "Ana",
  lastName: "Silva", language: "pt", amountCents: 1500, status: "pending",
  easypayCheckoutId: "chk-1", easypayPaymentId: null, method: null, createdAt: new Date(), paidAt: null,
};

let ledgerInsert: Array<{ id: number }> = [{ id: 1 }];
let claimRows: unknown[] = [{ id: 5 }];
let currentOrder: Record<string, unknown> | null = order;
const ledgerSets: Array<Record<string, any>> = [];
const orderSets: Array<Record<string, any>> = [];
const txValues = vi.fn();
const subscriptionUserFind = vi.fn();

vi.mock("../../src/db/index.ts", () => {
  const tx = {
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(claimRows) }) }) })),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        txValues(v);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ userId: 3 }]) }) };
      },
    })),
  };
  return {
    db: {
      query: {
        users: { findFirst: (...a: unknown[]) => subscriptionUserFind(...a) },
        teachingOrders: { findFirst: () => Promise.resolve(currentOrder) },
        events: { findFirst: () => Promise.resolve({ id: 8, titleEn: "T", titlePt: "T", status: "published" }) },
      },
      transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
      insert: vi.fn(() => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(ledgerInsert) }),
        }),
      })),
      update: vi.fn((table: any) => ({
        set: (v: Record<string, any>) => {
          // The ledger table has a notification_id column; the orders table does not.
          if ("action" in v || "note" in v) ledgerSets.push(v);
          else orderSets.push(v);
          void table;
          return { where: () => Promise.resolve() };
        },
      })),
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]), orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) })),
      delete: vi.fn(() => ({ where: () => Promise.resolve() })),
    },
  };
});
vi.mock("../../src/services/sync-versions.ts", () => ({ bumpUserAccessVersion: vi.fn(async () => {}) }));
const sendEmail = vi.fn(async () => {});
vi.mock("../../src/services/email.ts", () => ({ sendEmail: (...a: unknown[]) => (sendEmail as any)(...a) }));

import { testJson } from "../helpers.ts";

type Routes = Record<string, { ok: boolean; body: unknown }>;
function stubEasypay(routes: Routes) {
  const fn = vi.fn((url: string) => {
    const path = url.replace(/^.*\/2\.0/, "");
    const hit = routes[path];
    return Promise.resolve({
      ok: !!hit?.ok,
      status: hit?.ok ? 200 : 404,
      json: () => Promise.resolve(hit?.body ?? {}),
      text: () => Promise.resolve("{}"),
    } as unknown as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const single = (o: Record<string, unknown> = {}) => ({
  ok: true,
  body: { id: "pay-1", key: `teaching-order-${PUBLIC_ID}`, value: 15, payment_status: "paid", method: { type: "MBW" }, ...o },
});

const notification = { id: "pay-1", key: "txn-1", type: "capture", status: "success", date: "2026-11-03 10:00:00" };
const notify = (b: Record<string, unknown> = notification) =>
  testJson("/api/payment/webhook", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  ledgerInsert = [{ id: 1 }];
  claimRows = [{ id: 5 }];
  currentOrder = { ...order };
  ledgerSets.length = 0;
  orderSets.length = 0;
  subscriptionUserFind.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/payment/webhook for single teaching payments", () => {
  it("should finalize the order, grant once and email once when a paid single carries our key", async () => {
    const fetchMock = stubEasypay({ "/single/pay-1": single() });
    const { status } = await notify();
    expect(status).toBe(200);
    expect(txValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 3, eventId: 8, source: "purchase", orderId: 5 }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/subscription/"))).toBe(false);
    expect(ledgerSets.some((s) => String(s.action).startsWith("teaching"))).toBe(true);
  });

  it("should record and ignore a single payment whose key is not a teaching order", async () => {
    stubEasypay({ "/single/pay-1": single({ key: "something-else" }) });
    const { status } = await notify();
    expect(status).toBe(200);
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(ledgerSets.length).toBeGreaterThan(0);
  });

  it("should ignore the notification when the single lookup fails and nothing else resolves", async () => {
    stubEasypay({});
    const { status } = await notify();
    expect(status).toBe(200);
    expect(txValues).not.toHaveBeenCalled();
    expect(ledgerSets.some((s) => s.action === "unverified")).toBe(true);
  });

  it("should ignore a teaching key whose order does not exist", async () => {
    currentOrder = null;
    stubEasypay({ "/single/pay-1": single() });
    expect((await notify()).status).toBe(200);
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should not finalize when the paid amount differs from the order amount", async () => {
    stubEasypay({ "/single/pay-1": single({ value: 1 }) });
    const { status } = await notify();
    expect(status).toBe(200);
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(ledgerSets.some((s) => /amount_mismatch/.test(String(s.action) + String(s.note)))).toBe(true);
  });

  it("should mark the order failed and grant nothing when the payment failed", async () => {
    stubEasypay({ "/single/pay-1": single({ payment_status: "failed" }) });
    const { status } = await notify({ ...notification, status: "failed" });
    expect(status).toBe(200);
    expect(orderSets).toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should do nothing more when the same notification is delivered twice", async () => {
    const fetchMock = stubEasypay({ "/single/pay-1": single() });
    ledgerInsert = [];
    const { status, body } = await notify();
    expect(status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should grant once when another caller already won the status flip", async () => {
    claimRows = [];
    stubEasypay({ "/single/pay-1": single() });
    await notify();
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should not trust the notification body: a paid body with a pending single grants nothing", async () => {
    stubEasypay({ "/single/pay-1": single({ payment_status: "pending" }) });
    await notify();
    expect(txValues).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should leave subscription notifications on the subscription path without probing /single", async () => {
    const fetchMock = stubEasypay({ "/subscription/sub-abc": { ok: true, body: { id: "sub-abc", value: 5, customer: { key: "user-7" } } } });
    subscriptionUserFind.mockResolvedValue({ id: 7, email: "m@test.com", subscriptionStatus: "none", subscriptionExpiresAt: null });
    await notify({ id: "sub-abc", type: "subscription_capture", status: "success", date: "d" });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/single/"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/subscription/sub-abc"))).toBe(true);
  });

  it("should fall through to the subscription path when a capture is not a single payment", async () => {
    const fetchMock = stubEasypay({ "/subscription/sub-abc": { ok: true, body: { id: "sub-abc", value: 5, customer: { key: "user-7" } } } });
    subscriptionUserFind.mockResolvedValue({ id: 7, email: "m@test.com", subscriptionStatus: "none", subscriptionExpiresAt: null });
    await notify({ id: "sub-abc", type: "capture", status: "success", date: "d" });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/subscription/sub-abc"))).toBe(true);
    expect(txValues).not.toHaveBeenCalled();
  });
});
