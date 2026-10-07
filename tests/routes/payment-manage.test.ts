import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Member-side management: change amount, resume, replace payment method, cancel.
 * Real-Easypay mode (see payment-webhook.test.ts for why the env is hoisted).
 */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

/** Every `db.update(...).set(values)` payload, in call order. */
let dbWrites: Array<Record<string, any>> = [];

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, any>) => {
        dbWrites.push(values);
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
  },
}));

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

import { sendEmail } from "../../src/services/email.ts";
import { testJson } from "../helpers.ts";
import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { easypayDateTime, addInterval } from "../../src/services/membership.ts";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

interface Call {
  url: string;
  method: string;
  body: any;
}
let calls: Call[] = [];

/** Routes Easypay by method + path; `sub` is what GET /subscription/:id returns. */
function stubEasypay(sub: unknown = { id: "sub-abc", frequency: "1M", value: 5 }) {
  calls = [];
  global.fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    const payload = url.includes("/checkout")
      ? { id: "chk-1", session: "sess-1" }
      : method === "GET"
        ? sub
        : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

const patches = () => calls.filter((c) => c.method === "PATCH");

function member(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    email: "member@test.com",
    firstName: "Ana",
    lastName: "Silva",
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

async function post(path: string, body?: unknown) {
  const token = await createAccessToken({ sub: 7, email: "member@test.com", role: "user" });
  return testJson(`/api/payment/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbWrites = [];
  (db.query.users.findFirst as any).mockResolvedValue(member());
  stubEasypay();
});

describe("POST /api/payment/amount", () => {
  it("should return 401 without a token", async () => {
    const { status } = await testJson("/api/payment/amount", { method: "POST", body: "{}" });
    expect(status).toBe(401);
  });

  it("should patch the Easypay value and store the new amount when valid", async () => {
    const { status, body } = await post("amount", { amount: 15 });
    expect(status).toBe(200);
    expect(body).toEqual({ amount: 15 });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toContain("/subscription/sub-abc");
    expect(patches()[0]!.body).toEqual({ value: 15 });
    expect(dbWrites[0]).toMatchObject({ subscriptionAmount: "15" });
  });

  it("should reject an amount below the yearly floor for a yearly subscription", async () => {
    stubEasypay({ id: "sub-abc", frequency: "1Y", value: 60 });
    const { status, body } = await post("amount", { amount: 30 });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_CONTRIBUTION");
    expect(patches()).toHaveLength(0);
  });

  it("should ignore an interval sent by the client and use the Easypay frequency", async () => {
    stubEasypay({ id: "sub-abc", frequency: "1Y", value: 60 });
    const { status, body } = await post("amount", { amount: 6, interval: "month" });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_CONTRIBUTION");
  });

  it("should reject a non-numeric amount", async () => {
    const { status, body } = await post("amount", { amount: "lots" });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_CONTRIBUTION");
  });

  it("should return NOT_EASYPAY_MEMBER for an admin-granted member", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(
      member({ subscriptionSource: "admin", easypaySubscriptionId: null }),
    );
    const { status, body } = await post("amount", { amount: 15 });
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_EASYPAY_MEMBER");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should return NOT_EASYPAY_MEMBER for a mock subscription id", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: "mock_sub_7" }));
    const { body } = await post("amount", { amount: 15 });
    expect(body.code).toBe("NOT_EASYPAY_MEMBER");
  });

  it("should return ACCESS_ENDED when access has ended", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: daysFromNow(-30) }));
    const { status, body } = await post("amount", { amount: 15 });
    expect(status).toBe(400);
    expect(body.code).toBe("ACCESS_ENDED");
    expect(body.error).toBe("Your membership has ended. Please join again.");
    expect(patches()).toHaveLength(0);
  });
});

describe("POST /api/payment/resume", () => {
  const cancelled = (overrides: Record<string, any> = {}) =>
    member({ subscriptionCancelledAt: new Date(), ...overrides });

  it("should reactivate at Easypay from the paid-through date and clear the cancellation", async () => {
    const expires = daysFromNow(20);
    (db.query.users.findFirst as any).mockResolvedValue(cancelled({ subscriptionExpiresAt: expires }));
    stubEasypay({ id: "sub-abc", frequency: "1Y", value: 60 });

    const { status, body } = await post("resume");
    expect(status).toBe(200);
    expect(body).toEqual({ accessUntil: expires.toISOString() });
    expect(patches()[0]!.body).toEqual({
      status: "active",
      frequency: "1Y",
      start_time: easypayDateTime(expires),
    });
    expect(dbWrites[0]).toMatchObject({ subscriptionCancelledAt: null });
  });

  it("should answer with an error and keep the cancellation when Easypay refuses the reactivation", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(cancelled());
    stubEasypay({ id: "sub-abc", frequency: "1M", value: 5 });
    const original = global.fetch as any;
    global.fetch = vi.fn((url: string, init: RequestInit = {}) =>
      init.method === "PATCH"
        ? Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") } as unknown as Response)
        : original(url, init),
    ) as unknown as typeof fetch;

    const { status } = await post("resume");
    expect(status).toBeGreaterThanOrEqual(500);
    expect(dbWrites).toHaveLength(0);
  });

  it("should restart five minutes from now when the paid-through date is already past but still within grace", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(cancelled({ subscriptionExpiresAt: daysFromNow(-2) }));
    const before = Date.now();
    const { status } = await post("resume");
    expect(status).toBe(200);
    const start = new Date(patches()[0]!.body.start_time.replace(" ", "T") + ":00Z").getTime();
    expect(start).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(start).toBeLessThanOrEqual(before + 7 * 60 * 1000);
    expect(dbWrites[0]).toMatchObject({ subscriptionCancelledAt: null });
  });

  it("should return NOT_CANCELLED when the member has not cancelled", async () => {
    const { status, body } = await post("resume");
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_CANCELLED");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should return ACCESS_ENDED once access and grace are over", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(cancelled({ subscriptionExpiresAt: daysFromNow(-30) }));
    const { status, body } = await post("resume");
    expect(status).toBe(400);
    expect(body.code).toBe("ACCESS_ENDED");
    expect(body.error ?? body.message).toBe("Your membership has ended. Please join again.");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dbWrites).toHaveLength(0);
  });

  it("should return NOT_EASYPAY_MEMBER for an admin-granted member", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(
      cancelled({ subscriptionSource: "admin", easypaySubscriptionId: null }),
    );
    const { body } = await post("resume");
    expect(body.code).toBe("NOT_EASYPAY_MEMBER");
  });
});

describe("POST /api/payment/update-method", () => {
  const checkout = () => calls.find((c) => c.url.endsWith("/checkout"))!;

  it("should not charge now and start at the paid-through date while access is active", async () => {
    const expires = daysFromNow(20);
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: expires }));
    stubEasypay({ id: "sub-abc", frequency: "1Y", value: 40 });

    const { status, body } = await post("update-method", { language: "pt" });
    expect(status).toBe(200);
    expect(checkout().body.payment.capture_now).toBe(false);
    expect(checkout().body.payment.start_time).toBe(easypayDateTime(expires));
    expect(checkout().body.payment.frequency).toBe("1Y");
    expect(checkout().body.order.value).toBe(40);
    expect(checkout().body.customer.key).toBe("user-7");
    expect(body.url).toContain("&mode=update");
    expect(body.url).toContain("&amount=40&interval=year&lang=pt");
  });

  it("should not write a checkout ledger row, so a card update never blocks anything", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: daysFromNow(20) }));
    stubEasypay({ id: "sub-abc", frequency: "1M", value: 5 });
    await post("update-method", {});
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should use now plus five minutes when the paid-through date is already past", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: daysFromNow(-2) }));
    const before = Date.now();
    await post("update-method", {});
    const start = new Date(checkout().body.payment.start_time.replace(" ", "T") + ":00Z").getTime();
    expect(checkout().body.payment.capture_now).toBe(false);
    expect(start).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(start).toBeLessThanOrEqual(before + 7 * 60 * 1000);
  });

  it("should charge now and start one interval later when access has lapsed", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionExpiresAt: daysFromNow(-30) }));
    const { body } = await post("update-method", {});
    expect(checkout().body.payment.capture_now).toBe(true);
    expect(checkout().body.payment.start_time).toBe(easypayDateTime(addInterval(new Date(), "month")));
    expect(body.url).toContain("&mode=update");
  });

  it("should answer 502 EASYPAY_UNAVAILABLE and open no checkout when Easypay cannot be read", async () => {
    // Regression: falling back to "month" + the stored amount could give a yearly member a
    // monthly charge at the yearly amount.
    stubEasypay();
    const original = global.fetch as any;
    global.fetch = vi.fn((url: string, init: RequestInit = {}) =>
      (init.method ?? "GET") === "GET" && url.includes("/subscription/")
        ? Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") } as unknown as Response)
        : original(url, init),
    ) as unknown as typeof fetch;
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionAmount: "120.00" }));

    const { status, body } = await post("update-method", {});
    expect(status).toBe(502);
    expect(body.code).toBe("EASYPAY_UNAVAILABLE");
    expect(body.error).not.toMatch(/subscri/i);
    expect(calls.find((c) => c.url.endsWith("/checkout"))).toBeUndefined();
  });

  it("should answer 502 EASYPAY_UNAVAILABLE when Easypay returns no frequency", async () => {
    stubEasypay({ id: "sub-abc", value: 120 });
    const { status, body } = await post("update-method", {});
    expect(status).toBe(502);
    expect(body.code).toBe("EASYPAY_UNAVAILABLE");
    expect(calls.find((c) => c.url.endsWith("/checkout"))).toBeUndefined();
  });

  it("should refuse a cancelled member and open no checkout", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionCancelledAt: new Date() }));
    const { status, body } = await post("update-method", {});
    expect(status).toBe(400);
    expect(body.code).toBe("MEMBERSHIP_CANCELLED");
    expect(body.error).toBe("Resume your membership before changing the payment method.");
    expect(calls).toEqual([]);
  });

  it("should return NOT_EASYPAY_MEMBER for an admin-granted member", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(
      member({ subscriptionSource: "admin", easypaySubscriptionId: null }),
    );
    const { status, body } = await post("update-method", {});
    expect(status).toBe(400);
    expect(body.code).toBe("NOT_EASYPAY_MEMBER");
  });
});

describe("POST /api/payment/cancel", () => {
  it("should stop Easypay and record the cancellation the first time", async () => {
    const { status, body } = await post("cancel");
    expect(status).toBe(200);
    expect(patches()[0]!.body).toEqual({ status: "inactive" });
    expect(body.url).toMatch(/\/membership$/);
    expect(body).toHaveProperty("accessUntil");
  });

  it("should point the already-cancelled answer at the membership page", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ subscriptionCancelledAt: new Date() }));
    const { body } = await post("cancel");
    expect(body.url).toMatch(/\/membership$/);
  });

  it("should explain in membership words when there is nothing at Easypay to cancel", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: null }));
    const { status, body } = await post("cancel");
    expect(status).toBe(400);
    expect(body.error).not.toMatch(/subscri/i);
  });

  it("should return the same body without calling Easypay when already cancelled", async () => {
    const expires = daysFromNow(20);
    (db.query.users.findFirst as any).mockResolvedValue(
      member({ subscriptionCancelledAt: new Date(), subscriptionExpiresAt: expires }),
    );
    const { status, body } = await post("cancel");
    expect(status).toBe(200);
    expect(body.accessUntil).toBe(expires.toISOString());
    expect(typeof body.url).toBe("string");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(dbWrites).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should send one cancelled email on the first cancellation", async () => {
    await post("cancel");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as any).mock.calls[0][0];
    expect(arg.to).toBe("member@test.com");
    expect(arg.subject).toContain("Your Padmakara membership ends on");
  });

  it("should still answer 200 when the cancelled email fails", async () => {
    (sendEmail as any).mockImplementationOnce(() => Promise.reject(new Error("SES down")));
    const { status } = await post("cancel");
    expect(status).toBe(200);
  });
});
