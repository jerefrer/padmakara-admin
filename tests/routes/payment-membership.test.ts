import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Read side of the membership: GET /membership and GET /checkout-status/:id.
 * Real-Easypay mode (see payment-webhook.test.ts for why the env is hoisted).
 */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

/** Set per-test: what the ledger query returns (newest first, as the DB would). */
let ledgerRows: Array<Record<string, any>> = [];
/** Every argument handed to `.orderBy()`, so tests can see how the ledger was sorted. */
let orderByArgs: unknown[] = [];

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn((...args: unknown[]) => {
            orderByArgs.push(...args);
            return { limit: vi.fn(() => Promise.resolve(ledgerRows)) };
          }),
        })),
      })),
    })),
  },
}));

import { testJson } from "../helpers.ts";
import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { membershipState } from "../../src/routes/payment.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

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

function member(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    email: "member@test.com",
    role: "user",
    subscriptionStatus: "active",
    subscriptionSource: "easypay",
    easypaySubscriptionId: "sub-abc",
    subscriptionExpiresAt: daysFromNow(20),
    subscriptionCancelledAt: null,
    subscriptionAmount: "5.00",
    ...overrides,
  };
}

async function authHeader() {
  const token = await createAccessToken({ sub: 7, email: "member@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

async function getMembership() {
  return testJson("/api/payment/membership", { headers: await authHeader() });
}

const failedCapture = {
  notificationType: "subscription_capture",
  action: "ignored",
  note: "payment_failed",
  amount: "5.00",
  createdAt: new Date("2026-09-09T10:00:00Z"),
};

describe("membershipState", () => {
  const active = member();

  it("should return none when the user never had a membership", () => {
    expect(
      membershipState(member({ subscriptionStatus: "none", subscriptionExpiresAt: null }), null),
    ).toBe("none");
  });

  it("should return lapsed when access is gone past the grace period", () => {
    expect(membershipState(member({ subscriptionExpiresAt: daysFromNow(-30) }), null)).toBe("lapsed");
  });

  it("should return cancelled when access is active and the member cancelled", () => {
    expect(membershipState(member({ subscriptionCancelledAt: new Date() }), null)).toBe("cancelled");
  });

  it("should return payment_failed when the newest capture was a failed charge", () => {
    expect(membershipState(active, { action: "ignored", note: "payment_failed" })).toBe("payment_failed");
  });

  it("should return active when the newest capture succeeded", () => {
    expect(membershipState(active, { action: "extended", note: null })).toBe("active");
  });

  it("should prefer cancelled over payment_failed", () => {
    expect(
      membershipState(member({ subscriptionCancelledAt: new Date() }), {
        action: "ignored",
        note: "payment_failed",
      }),
    ).toBe("cancelled");
  });
});

describe("GET /api/payment/membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerRows = [];
    (db.query.users.findFirst as any).mockResolvedValue(member());
    stubEasypay({ id: "sub-abc", frequency: "1Y", method: { type: "CC", status: "active", last_four: "4242", card_type: "visa" } });
  });

  it("should return 401 without a token", async () => {
    const { status } = await testJson("/api/payment/membership");
    expect(status).toBe(401);
  });

  it("should report none for a user without any membership", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(
      member({ subscriptionStatus: "none", subscriptionSource: null, easypaySubscriptionId: null, subscriptionExpiresAt: null, subscriptionAmount: null }),
    );
    const { status, body } = await getMembership();
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: "none", source: null, amount: null, interval: null, accessUntil: null, method: null, history: [] });
  });

  it("should report active with amount, interval and card details", async () => {
    const { status, body } = await getMembership();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      state: "active",
      source: "easypay",
      amount: 5,
      interval: "year",
      graceUntil: null,
      cancelledAt: null,
      method: { type: "card", lastFour: "4242", brand: "visa" },
    });
    expect(typeof body.accessUntil).toBe("string");
  });

  it("should report cancelled with the cancellation date", async () => {
    const at = new Date("2026-10-01T09:00:00Z");
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionCancelledAt: at }));
    const { body } = await getMembership();
    expect(body.state).toBe("cancelled");
    expect(body.cancelledAt).toBe(at.toISOString());
  });

  it("should report payment_failed with graceUntil seven days after accessUntil", async () => {
    const expires = daysFromNow(-2);
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: expires }));
    ledgerRows = [failedCapture];
    const { body } = await getMembership();
    expect(body.state).toBe("payment_failed");
    expect(new Date(body.graceUntil).getTime() - new Date(body.accessUntil).getTime()).toBe(7 * DAY);
  });

  it("should report lapsed once access and grace are over", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: daysFromNow(-30) }));
    const { body } = await getMembership();
    expect(body.state).toBe("lapsed");
    expect(body.graceUntil).toBeNull();
  });

  it("should return null method and interval, still 200, when Easypay fails", async () => {
    stubEasypay({}, false);
    const { status, body } = await getMembership();
    expect(status).toBe(200);
    expect(body.method).toBeNull();
    expect(body.interval).toBeNull();
    expect(body.state).toBe("active");
  });

  it("should not call Easypay for admin-granted or mock subscriptions", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionSource: "admin", easypaySubscriptionId: null }));
    const { body } = await getMembership();
    expect(body.source).toBe("admin");
    expect(body.method).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();

    (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: "mock_sub_7" }));
    await getMembership();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should map ledger rows to paid, failed and refunded, newest first", async () => {
    ledgerRows = [
      { ...failedCapture, createdAt: new Date("2026-09-09T10:00:00Z") },
      { notificationType: "subscription_capture", action: "extended", note: null, amount: "5.00", createdAt: new Date("2026-08-09T10:00:00Z") },
      { notificationType: "refund", action: "reversed", note: "refund/success", amount: null, createdAt: new Date("2026-08-10T10:00:00Z") },
      { notificationType: "capture", action: "activated", note: null, amount: "5.00", createdAt: new Date("2026-07-09T10:00:00Z") },
      { notificationType: "subscription_capture", action: "tokenized", note: null, amount: null, createdAt: new Date("2026-07-08T10:00:00Z") },
    ];
    const { body } = await getMembership();
    expect(body.history.map((h: any) => h.outcome)).toEqual(["failed", "paid", "refunded", "paid"]);
    expect(body.history[0]).toEqual({ date: "2026-09-09T10:00:00.000Z", amount: 5, outcome: "failed" });
    expect(body.history[2].amount).toBeNull();
  });
});

describe("GET /api/payment/membership ledger ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerRows = [];
    orderByArgs = [];
    (db.query.users.findFirst as any).mockResolvedValue(member());
    stubEasypay({ id: "sub-abc", frequency: "1M" });
  });

  it("should ask the database for the newest ledger rows first", async () => {
    // The route trusts the database to sort (the history and the "newest capture" both
    // read rows[0] as the newest), so the query's ORDER BY is the behaviour to pin.
    await getMembership();
    expect(orderByArgs).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(orderByArgs[0] as SQL);
    expect(rendered.sql).toMatch(/"created_at" desc$/);
  });
});

describe("first payment in flight", () => {
  const noAccess = () => member({ subscriptionStatus: "none", subscriptionExpiresAt: null, subscriptionSource: null, easypaySubscriptionId: null, subscriptionAmount: null });
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const checkout = (days: number) => ({ notificationType: "checkout", notificationId: "chk-9", action: "checkout_created", note: null, amount: "5.00", createdAt: ago(days) });
  const capture = (days: number, action: string, note: string | null = null) => ({ notificationType: "subscription_capture", notificationId: "sub-9", action, note, amount: "5.00", createdAt: ago(days) });
  const ddPending = { payment: { status: "pending" }, method: { type: "DD" } };

  beforeEach(() => {
    vi.clearAllMocks();
    ledgerRows = [];
    (db.query.users.findFirst as any).mockResolvedValue(noAccess());
    stubEasypay(ddPending);
  });

  it("should report processing when a Direct Debit checkout is pending at Easypay", async () => {
    ledgerRows = [checkout(1)];
    const { body } = await getMembership();
    expect(body.state).toBe("processing");
    expect(body.lastPaymentFailedAt).toBeNull();
    expect((global.fetch as any).mock.calls[0][0]).toContain("/checkout/chk-9");
  });

  it("should not report processing for a card checkout the member abandoned", async () => {
    stubEasypay({ payment: { status: "pending" }, method: { type: "cc" } });
    ledgerRows = [checkout(1)];
    const { body } = await getMembership();
    expect(body.state).toBe("none");
  });

  it("should not report processing when the Direct Debit payment failed at Easypay", async () => {
    stubEasypay({ payment: { status: "failed" }, method: { type: "dd" } });
    ledgerRows = [checkout(1)];
    const { body } = await getMembership();
    expect(body.state).toBe("none");
  });

  it("should end processing once a capture row is newer than the checkout row", async () => {
    ledgerRows = [capture(0.5, "ignored", "payment_failed"), checkout(1)];
    const { body } = await getMembership();
    expect(body.state).toBe("none");
  });

  it("should not report processing when the checkout row is older than 14 days", async () => {
    ledgerRows = [checkout(20)];
    const { body } = await getMembership();
    expect(body.state).toBe("none");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should fail open, not processing, when Easypay errors", async () => {
    stubEasypay({}, false);
    ledgerRows = [checkout(1)];
    const { status, body } = await getMembership();
    expect(status).toBe(200);
    expect(body.state).toBe("none");
  });

  it("should not report processing for a member who has access", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member());
    ledgerRows = [checkout(1)];
    stubEasypay({ id: "sub-abc", frequency: "1M" });
    const { body } = await getMembership();
    expect(body.state).toBe("active");
  });

  it("should set lastPaymentFailedAt from a failed first capture", async () => {
    const row = capture(1, "ignored", "payment_failed");
    ledgerRows = [row, checkout(2)];
    const { body } = await getMembership();
    expect(body.state).toBe("none");
    expect(body.lastPaymentFailedAt).toBe(row.createdAt.toISOString());
  });

  it("should clear lastPaymentFailedAt when a newer checkout means the member is retrying", async () => {
    stubEasypay({ payment: { status: "pending" }, method: { type: "cc" } });
    ledgerRows = [checkout(0.1), capture(1, "ignored", "payment_failed")];
    const { body } = await getMembership();
    expect(body.lastPaymentFailedAt).toBeNull();
  });

  it("should not set lastPaymentFailedAt when the failed capture is older than 14 days", async () => {
    ledgerRows = [capture(20, "ignored", "payment_failed")];
    const { body } = await getMembership();
    expect(body.lastPaymentFailedAt).toBeNull();
  });

  it("should not set lastPaymentFailedAt for a member who has access", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member());
    ledgerRows = [capture(1, "ignored", "payment_failed")];
    const { body } = await getMembership();
    expect(body.lastPaymentFailedAt).toBeNull();
  });

  it("should not list checkout rows in the history", async () => {
    ledgerRows = [checkout(1)];
    const { body } = await getMembership();
    expect(body.history).toEqual([]);
  });
});

describe("GET /api/payment/checkout-status/:id", () => {
  async function status(id = "chk-1") {
    return testJson(`/api/payment/checkout-status/${id}`, { headers: await authHeader() });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionStatus: "none", subscriptionExpiresAt: null }));
  });

  it("should return 401 without a token", async () => {
    const { status } = await testJson("/api/payment/checkout-status/chk-1");
    expect(status).toBe(401);
  });

  it("should return active without asking Easypay when access exists", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member());
    stubEasypay({});
    const res = await status();
    expect(res.body).toEqual({ state: "active", method: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should return processing for a direct debit that has not settled", async () => {
    stubEasypay({ payment: { status: "pending" }, method: { type: "DD" } });
    const res = await status();
    expect(res.body).toEqual({ state: "processing", method: "direct_debit" });
  });

  it("should return failed when the payment failed", async () => {
    stubEasypay({ payment: { status: "failed" }, method: { type: "cc" } });
    const res = await status();
    expect(res.body).toEqual({ state: "failed", method: "card" });
  });

  it.each([[404], [500]])("should answer pending, not an error, when Easypay answers %i", async (code) => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: code, text: () => Promise.resolve("boom") } as unknown as Response),
    ) as unknown as typeof fetch;
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "pending", method: null });
  });

  it("should answer pending when Easypay cannot be reached", async () => {
    global.fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "pending", method: null });
  });

  it("should return pending for a card payment still in progress", async () => {
    stubEasypay({ payment: { status: "pending" }, method: { type: "cc" } });
    const res = await status();
    expect(res.body).toEqual({ state: "pending", method: "card" });
  });
});
