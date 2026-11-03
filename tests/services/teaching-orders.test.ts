import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
});

const order = {
  id: 5,
  publicId: "11111111-1111-1111-1111-111111111111",
  eventId: 8,
  userId: 3,
  email: "buyer@example.com",
  firstName: "Ana",
  lastName: "Silva",
  language: "pt",
  amountCents: 1500,
  status: "pending",
  easypayCheckoutId: "chk-1",
  easypayPaymentId: null,
  method: null,
  createdAt: new Date(),
  paidAt: null,
};

let claimRows: unknown[] = [{ id: 5 }];
let grantRows: unknown[] = [{ userId: 3 }];
const txSet = vi.fn();
const txValues = vi.fn();
const dbSet = vi.fn();
const orderFindFirst = vi.fn();
const eventFindFirst = vi.fn();

vi.mock("../../src/db/index.ts", () => {
  const tx = {
    update: vi.fn(() => ({
      set: (v: unknown) => {
        txSet(v);
        return { where: () => ({ returning: () => Promise.resolve(claimRows) }) };
      },
    })),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        txValues(v);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(grantRows) }) };
      },
    })),
  };
  return {
    db: {
      query: {
        teachingOrders: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
        events: { findFirst: (...a: unknown[]) => eventFindFirst(...a) },
      },
      transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
      update: vi.fn(() => ({
        set: (v: unknown) => {
          dbSet(v);
          return { where: () => Promise.resolve() };
        },
      })),
    },
  };
});

const bump = vi.fn();
vi.mock("../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: (...a: unknown[]) => bump(...a),
}));
const sendEmail = vi.fn();
vi.mock("../../src/services/email.ts", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

import { finalizeOrder, refreshOrderFromEasypay } from "../../src/services/teaching-orders.ts";

const paid = { paymentId: "pay-1", method: "mbw", amountCents: 1500 };

beforeEach(() => {
  vi.clearAllMocks();
  claimRows = [{ id: 5 }];
  grantRows = [{ userId: 3 }];
  orderFindFirst.mockResolvedValue(order);
  eventFindFirst.mockResolvedValue({ id: 8, titleEn: "Teaching", titlePt: "Ensinamento", status: "published" });
  sendEmail.mockResolvedValue(undefined);
  bump.mockResolvedValue(undefined);
});

describe("finalizeOrder", () => {
  it("should mark paid, grant access, bump sync and email once when the order is pending", async () => {
    const r = await finalizeOrder(5, paid);
    expect(r).toBe("finalized");
    expect(txSet).toHaveBeenCalledWith(expect.objectContaining({ status: "paid", method: "mbw", easypayPaymentId: "pay-1" }));
    expect(txValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 3, eventId: 8, source: "purchase", orderId: 5 }));
    expect(bump).toHaveBeenCalledWith(3);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: "buyer@example.com" });
  });

  it("should return already and do nothing when the order is no longer pending", async () => {
    orderFindFirst.mockResolvedValue({ ...order, status: "paid" });
    expect(await finalizeOrder(5, paid)).toBe("already");
    expect(txSet).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should return already and not grant or email when another caller wins the race", async () => {
    claimRows = [];
    expect(await finalizeOrder(5, paid)).toBe("already");
    expect(txValues).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should return amount_mismatch and leave the order untouched when the paid amount differs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await finalizeOrder(5, { ...paid, amountCents: 100 })).toBe("amount_mismatch");
    expect(txSet).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("should store the grant and say not-published-yet in the email when the event is a draft", async () => {
    eventFindFirst.mockResolvedValue({ id: 8, titleEn: "T", titlePt: "T", status: "draft" });
    expect(await finalizeOrder(5, paid)).toBe("finalized");
    expect(txValues).toHaveBeenCalled();
    const mail = sendEmail.mock.calls[0]![0] as { text: string };
    expect(mail.text).toMatch(/avisamos|let you know/i);
  });

  it("should not bump sync when the user already had a grant but still email the winner", async () => {
    grantRows = [];
    expect(await finalizeOrder(5, paid)).toBe("finalized");
    expect(bump).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("should still finalize when the email fails", async () => {
    sendEmail.mockRejectedValue(new Error("ses down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await finalizeOrder(5, paid)).toBe("finalized");
    err.mockRestore();
  });

  it("should return already when the order does not exist", async () => {
    orderFindFirst.mockResolvedValue(undefined);
    expect(await finalizeOrder(99, paid)).toBe("already");
  });
});

function stubFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const key = Object.keys(responses).find((k) => url.endsWith(k));
      if (!key) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(responses[key]), { status: 200 });
    }),
  );
  return calls;
}

describe("refreshOrderFromEasypay", () => {
  it("should finalize when Easypay says the single payment is paid for the order amount", async () => {
    stubFetch({
      "/checkout/chk-1": { checkout: { id: "chk-1", status: "complete" }, payment: { id: "pay-1", status: "paid" } },
      "/single/pay-1": { id: "pay-1", key: `teaching-order-${order.publicId}`, payment_status: "paid", value: 15, method: { type: "MBW", status: "active" } },
    });
    await refreshOrderFromEasypay(order as never);
    expect(txSet).toHaveBeenCalledWith(expect.objectContaining({ status: "paid", method: "mbw", easypayPaymentId: "pay-1" }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("should not grant when the single payment key belongs to another order", async () => {
    stubFetch({
      "/checkout/chk-1": { payment: { id: "pay-1", status: "paid" } },
      "/single/pay-1": { id: "pay-1", key: "teaching-order-other", payment_status: "paid", value: 15, method: { type: "MB" } },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await refreshOrderFromEasypay(order as never);
    expect(txSet).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("should do nothing while the payment is still pending", async () => {
    stubFetch({
      "/checkout/chk-1": { payment: { id: "pay-1", status: "pending" } },
      "/single/pay-1": { id: "pay-1", key: `teaching-order-${order.publicId}`, payment_status: "pending", value: 15, method: { type: "MB", entity: "11683", reference: "663000450" } },
    });
    await refreshOrderFromEasypay(order as never);
    expect(txSet).not.toHaveBeenCalled();
    expect(dbSet).not.toHaveBeenCalled();
  });

  it("should mark the order failed when the payment failed, without granting", async () => {
    stubFetch({
      "/checkout/chk-1": { payment: { id: "pay-1", status: "failed" } },
      "/single/pay-1": { id: "pay-1", key: `teaching-order-${order.publicId}`, payment_status: "failed", value: 15, method: { type: "CC" } },
    });
    await refreshOrderFromEasypay(order as never);
    expect(dbSet).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(txValues).not.toHaveBeenCalled();
  });

  it("should do nothing when the checkout has no payment yet", async () => {
    stubFetch({ "/checkout/chk-1": { checkout: { id: "chk-1", status: "pending" } } });
    await refreshOrderFromEasypay(order as never);
    expect(txSet).not.toHaveBeenCalled();
  });
});
