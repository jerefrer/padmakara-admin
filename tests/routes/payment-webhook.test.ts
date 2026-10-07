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
/** Every table passed to db.delete(), so tests can see a released claim. */
let deleteCalls: unknown[] = [];
/** Every payload passed to db.insert().values(), so tests can see ledger rows we write. */
let insertedValues: Array<Record<string, any>> = [];

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, any>) => {
        insertedValues.push(v);
        return {
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(insertReturns)),
        })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(selectReturns)),
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(selectReturns)) })),
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
          return { where: vi.fn(() => Promise.resolve(undefined)) };
        }),
      };
    }),
  },
}));

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

import { sendEmail } from "../../src/services/email.ts";
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
    selectReturns = [];
    deleteCalls = [];
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

  it("should deactivate the stored subscription and adopt the new one when a capture arrives before its subscription_create", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(easypaySubscription());

    const { status } = await notify(capture);

    expect(status).toBe(200);
    expect(patchedUrls()).toEqual([expect.stringContaining("/subscription/sub-old")]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "sub-abc", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "extended", note: "replaced sub-old" });
  });

  it("should clear the cancellation without stopping the old subscription again when a cancelled lapsed member rejoins", async () => {
    // Cancel already PATCHed the old subscription inactive before recording subscriptionCancelledAt.
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() - 30 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: new Date(Date.now() - 60 * 86_400_000),
    });
    stubEasypayRoutes(easypaySubscription());

    await notify(capture);

    expect(patchedUrls()).toEqual([]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "sub-abc", subscriptionCancelledAt: null });
  });

  it("should extend access but keep the stored id when a capture arrives for an already-replaced subscription", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-new", subscriptionCancelledAt: null,
    });
    selectReturns = [{ id: 3 }]; // ledger: sub-abc was replaced by sub-new
    stubEasypayRoutes(easypaySubscription());

    const { status } = await notify(capture);

    expect(status).toBe(200);
    const set = usersUpdate()!;
    expect(set.subscriptionExpiresAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty("easypaySubscriptionId");
    expect(set).not.toHaveProperty("subscriptionCancelledAt");
    // It should not be charging at all: try once more to stop it.
    expect(patchedUrls()).toEqual([expect.stringContaining("/subscription/sub-abc")]);
    expect(ledgerUpdate()).toMatchObject({ action: "extended", note: "capture on replaced sub-abc" });
  });

  it("should still extend access and record the failure when the old subscription cannot be stopped on a capture", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(easypaySubscription(), { patchOk: false });

    const { status } = await notify(capture);

    expect(status).toBe(200);
    expect(deleteCalls).toEqual([]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "sub-abc", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "extended", note: "replaced sub-old; deactivation failed" });
  });

  it("should release the claim and answer 503 when the old subscription cannot be stopped on subscription_create", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: null,
    });
    stubEasypayRoutes(easypaySubscription({ id: "sub-new" }), { patchOk: false });

    const { status } = await notify({ id: "sub-new", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" });

    expect(status).toBe(503);
    expect(deleteCalls).toEqual([paymentTransactions]);
    expect(usersUpdate()).toBeNull();
  });

  it("should not adopt an already-replaced subscription when its subscription_create arrives late", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-new", subscriptionCancelledAt: null,
    });
    selectReturns = [{ id: 3 }];
    stubEasypayRoutes(easypaySubscription({ id: "sub-abc" }));

    const { status } = await notify({ id: "sub-abc", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" });

    expect(status).toBe(200);
    expect(usersUpdate()).toBeNull();
    expect(ledgerUpdate()).toMatchObject({ action: "ignored", note: "create on replaced sub-abc" });
  });

  it("should extend a yearly member by a year", async () => {
    stubEasypay(easypaySubscription({ frequency: "1Y" }));
    await notify(capture);
    const days = ((usersUpdate()!.subscriptionExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });
});

describe("membership emails from the webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturns = [{ id: 1 }];
    updateCalls = [];
    selectReturns = [];
    deleteCalls = [];
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, email: "member@test.com", firstName: "Ana", preferredLanguage: "pt",
      subscriptionStatus: "none", subscriptionExpiresAt: null, subscriptionAmount: null,
    });
    (sendEmail as any).mockImplementation(() => Promise.resolve());
  });

  it("should send one welcome email on first activation", async () => {
    stubEasypay(easypaySubscription({ value: 12 }));
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
    stubEasypay(easypaySubscription());
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
    expect(arg.subject).toBe("We couldn't take your Padmakara contribution");
    const grace = new Date(expiry);
    grace.setDate(grace.getDate() + 7);
    const expected = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(grace);
    expect(arg.html).toContain(expected);
  });

  it("should not send a payment-failed email when access has already ended", async () => {
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
    stubEasypay(easypaySubscription());
    await notify(capture);
    expect(ledgerUpdate()).toMatchObject({ action: "activated" });
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

  it("should not send the first-payment-failed email for a failed subscription_create", async () => {
    stubEasypay(easypaySubscription());
    await notify({ ...capture, type: "subscription_create", status: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should not send an email for an unrecognised notification type", async () => {
    stubEasypay(easypaySubscription());
    await notify({ ...capture, type: "something-new" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should still answer 200 when the mail fails", async () => {
    (sendEmail as any).mockImplementation(() => Promise.reject(new Error("SES down")));
    stubEasypay(easypaySubscription());
    const { status, body } = await notify(capture);
    expect(status).toBe(200);
    expect(body.received).toBe(true);
  });

  it("should still answer 200 when the mail throws synchronously", async () => {
    (sendEmail as any).mockImplementation(() => { throw new Error("boom"); });
    stubEasypay(easypaySubscription());
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
    expect(sent.payment.capture.descriptive).toBe("Padmakara membership");
    const start = new Date(sent.payment.start_time.replace(" ", "T") + ":00Z");
    const daysOut = (start.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(27);
    expect(daysOut).toBeLessThan(32);
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
});
