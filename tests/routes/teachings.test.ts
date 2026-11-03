import { describe, it, expect, vi, beforeEach } from "vitest";

/** Real-Easypay mode: isMockMode is a module const, so the env must exist before imports. */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
  process.env.EASYPAY_API_KEY = "test-key";
  process.env.EASYPAY_TESTING = "true";
});

const eventFindFirst = vi.fn();
const userFindFirst = vi.fn();
const orderFindFirst = vi.fn();
const grantFindMany = vi.fn();
const eventFindMany = vi.fn();
const insertValues = vi.fn();
const updateSet = vi.fn();
let insertReturns: unknown[] = [{ id: 5, publicId: "11111111-1111-1111-1111-111111111111" }];

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: { findFirst: (...a: unknown[]) => eventFindFirst(...a), findMany: (...a: unknown[]) => eventFindMany(...a) },
      users: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
      teachingOrders: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
      eventAccessGrants: { findMany: (...a: unknown[]) => grantFindMany(...a) },
    },
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        insertValues(v);
        return { returning: () => Promise.resolve(insertReturns) };
      },
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSet(v);
        return { where: () => Promise.resolve() };
      },
    })),
  },
}));

const findOrCreateUserByEmail = vi.fn();
vi.mock("../../src/services/users-lookup.ts", () => ({
  findOrCreateUserByEmail: (...a: unknown[]) => findOrCreateUserByEmail(...a),
}));
const grantEventAccess = vi.fn();
vi.mock("../../src/services/event-access.ts", () => ({
  grantEventAccess: (...a: unknown[]) => grantEventAccess(...a),
}));
const hasEventGrant = vi.fn();
const checkEventAccess = vi.fn();
vi.mock("../../src/services/access.ts", async (orig) => ({
  ...(await orig<object>()),
  hasEventGrant: (...a: unknown[]) => hasEventGrant(...a),
  checkEventAccess: (...a: unknown[]) => checkEventAccess(...a),
}));
const sendEmail = vi.fn();
vi.mock("../../src/services/email.ts", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
const finalizeOrder = vi.fn();
const lookupSinglePayment = vi.fn();
const refreshOrderFromEasypay = vi.fn();
vi.mock("../../src/services/teaching-orders.ts", async (orig) => ({
  ...(await orig<object>()),
  finalizeOrder: (...a: unknown[]) => finalizeOrder(...a),
  lookupSinglePayment: (...a: unknown[]) => lookupSinglePayment(...a),
  refreshOrderFromEasypay: (...a: unknown[]) => refreshOrderFromEasypay(...a),
}));

import { testJson } from "../helpers.ts";
import { createAccessToken } from "../../src/services/auth.ts";

const PUBLIC_ID = "11111111-1111-1111-1111-111111111111";
const body = { email: " Buyer@Example.com ", firstName: "Ana", lastName: "Silva", language: "pt", consent: true };
const post = (path: string, b: unknown) =>
  testJson(path, { method: "POST", body: JSON.stringify(b) });

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    titleEn: "Teaching",
    titlePt: "Ensinamento",
    startDate: "2026-04-12",
    endDate: "2026-04-13",
    imageUrl: null,
    status: "published",
    saleMode: "paid",
    priceCents: 1500,
    audience: { slug: "restricted" },
    eventTeachers: [{ teacher: { name: "Rinpoche" } }],
    eventPlaces: [{ place: { name: "Lisbon" } }],
    sessions: [{ id: 1 }, { id: 2 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturns = [{ id: 5, publicId: PUBLIC_ID }];
  eventFindFirst.mockResolvedValue(event());
  userFindFirst.mockResolvedValue({ id: 3, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null });
  findOrCreateUserByEmail.mockResolvedValue({ user: { id: 3, email: "buyer@example.com", preferredLanguage: "pt" }, created: true });
  hasEventGrant.mockResolvedValue(false);
  checkEventAccess.mockResolvedValue({ allowed: false, reason: "ACCESS_DENIED" });
  grantEventAccess.mockResolvedValue({ created: true });
  sendEmail.mockResolvedValue(undefined);
  lookupSinglePayment.mockResolvedValue(null);
  refreshOrderFromEasypay.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: "chk-1", session: "sess-1" }), { status: 200 })),
  );
});

describe("GET /api/teachings/:eventId", () => {
  it("should return the public sale card when the event is on sale", async () => {
    const { status, body: b } = await testJson("/api/teachings/8");
    expect(status).toBe(200);
    expect(b).toEqual({
      id: 8,
      titleEn: "Teaching",
      titlePt: "Ensinamento",
      startDate: "2026-04-12",
      endDate: "2026-04-13",
      imageUrl: null,
      teachers: [{ name: "Rinpoche" }],
      places: [{ name: "Lisbon" }],
      sessionCount: 2,
      published: true,
      saleMode: "paid",
      priceCents: 1500,
    });
  });

  it("should flag a draft event as not published but still show it", async () => {
    eventFindFirst.mockResolvedValue(event({ status: "draft" }));
    const { status, body: b } = await testJson("/api/teachings/8");
    expect(status).toBe(200);
    expect(b.published).toBe(false);
  });

  it("should return 404 when the event is not on sale", async () => {
    eventFindFirst.mockResolvedValue(event({ saleMode: "none" }));
    expect((await testJson("/api/teachings/8")).status).toBe(404);
  });

  it("should return 404 when the event is archived", async () => {
    eventFindFirst.mockResolvedValue(event({ status: "archived" }));
    expect((await testJson("/api/teachings/8")).status).toBe(404);
  });

  it("should return 404 when the event does not exist or the id is not a number", async () => {
    eventFindFirst.mockResolvedValue(undefined);
    expect((await testJson("/api/teachings/8")).status).toBe(404);
    expect((await testJson("/api/teachings/abc")).status).toBe(404);
  });
});

describe("POST /api/teachings/:eventId/checkout", () => {
  it("should return 400 when consent is not true", async () => {
    expect((await post("/api/teachings/8/checkout", { ...body, consent: false })).status).toBe(400);
    expect(findOrCreateUserByEmail).not.toHaveBeenCalled();
  });

  it("should return 400 when the email is invalid or the language unknown", async () => {
    expect((await post("/api/teachings/8/checkout", { ...body, email: "nope" })).status).toBe(400);
    expect((await post("/api/teachings/8/checkout", { ...body, language: "fr" })).status).toBe(400);
  });

  it("should return 404 when the event is not on sale", async () => {
    eventFindFirst.mockResolvedValue(event({ saleMode: "none" }));
    expect((await post("/api/teachings/8/checkout", body)).status).toBe(404);
  });

  it("should return 404 when the event is archived", async () => {
    eventFindFirst.mockResolvedValue(event({ status: "archived" }));
    expect((await post("/api/teachings/8/checkout", body)).status).toBe(404);
  });

  it("should return 409 ALREADY_HAS_ACCESS when the user already holds a grant", async () => {
    hasEventGrant.mockResolvedValue(true);
    const { status, body: b } = await post("/api/teachings/8/checkout", body);
    expect(status).toBe(409);
    expect(b.code).toBe("ALREADY_HAS_ACCESS");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("should return 409 when the user already has access another way (group, admin)", async () => {
    checkEventAccess.mockResolvedValue({ allowed: true });
    const { status, body: b } = await post("/api/teachings/8/checkout", body);
    expect(status).toBe(409);
    expect(b.code).toBe("ALREADY_HAS_ACCESS");
  });

  describe("free mode", () => {
    beforeEach(() => eventFindFirst.mockResolvedValue(event({ saleMode: "free", priceCents: null })));

    it("should grant access, email and return granted", async () => {
      const { status, body: b } = await post("/api/teachings/8/checkout", body);
      expect(status).toBe(200);
      expect(b).toEqual({ status: "granted" });
      expect(findOrCreateUserByEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "Buyer@Example.com", firstName: "Ana", lastName: "Silva", language: "pt" }),
      );
      expect(grantEventAccess).toHaveBeenCalledWith({ userId: 3, eventId: 8, source: "free" });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: "buyer@example.com" });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("should still return granted when the email fails", async () => {
      sendEmail.mockRejectedValue(new Error("ses"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await post("/api/teachings/8/checkout", body)).body).toEqual({ status: "granted" });
      err.mockRestore();
    });

    it("should grant on a draft event and tell the buyer it is not online yet", async () => {
      eventFindFirst.mockResolvedValue(event({ saleMode: "free", priceCents: null, status: "draft" }));
      await post("/api/teachings/8/checkout", body);
      expect(grantEventAccess).toHaveBeenCalled();
      expect((sendEmail.mock.calls[0]![0] as { text: string }).text).toMatch(/avisamos/i);
    });
  });

  describe("paid mode", () => {
    it("should create a pending order and an Easypay single checkout and return the checkout", async () => {
      const { status, body: b } = await post("/api/teachings/8/checkout", body);
      expect(status).toBe(200);
      expect(b).toEqual({
        status: "checkout",
        orderId: PUBLIC_ID,
        checkout: { id: "chk-1", session: "sess-1" },
        testing: true,
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 8, userId: 3, email: "buyer@example.com", amountCents: 1500, status: "pending", language: "pt" }),
      );
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(String(url)).toMatch(/\/checkout$/);
      const sent = JSON.parse((init as RequestInit).body as string);
      expect(sent.type).toEqual(["single"]);
      expect(sent.payment.methods).toEqual(["mb", "mbw"]);
      expect(sent.payment.key).toBe(`teaching-order-${PUBLIC_ID}`);
      expect(sent.payment.capture.descriptive).toBe("Padmakara");
      expect(sent.payment.currency).toBe("EUR");
      expect(sent.order.key).toBe(`teaching-order-${PUBLIC_ID}`);
      expect(sent.order.value).toBe(15);
      expect(sent.order.items[0]).toEqual({ description: "Ensinamento", quantity: 1, key: "event-8", value: 15 });
      expect(sent.customer).toMatchObject({ name: "Ana Silva", email: "buyer@example.com", key: "user-3", language: "PT" });
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ easypayCheckoutId: "chk-1" }));
      expect(grantEventAccess).not.toHaveBeenCalled();
    });

    it("should mark the order failed and return an error when Easypay refuses the checkout", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { status } = await post("/api/teachings/8/checkout", body);
      expect(status).toBe(500);
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
      err.mockRestore();
    });

    it("should refuse a paid event with no usable price", async () => {
      eventFindFirst.mockResolvedValue(event({ priceCents: null }));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await post("/api/teachings/8/checkout", body)).status).toBe(500);
      expect(insertValues).not.toHaveBeenCalled();
      err.mockRestore();
    });
  });
});

describe("GET /api/teachings/orders/:publicId", () => {
  const order = {
    id: 5,
    publicId: PUBLIC_ID,
    eventId: 8,
    status: "pending",
    method: null,
    amountCents: 1500,
    createdAt: new Date(),
    easypayCheckoutId: "chk-1",
  };

  it("should return the order status shape", async () => {
    orderFindFirst.mockResolvedValue({ ...order, status: "paid", method: "mbw" });
    const { status, body: b } = await testJson(`/api/teachings/orders/${PUBLIC_ID}`);
    expect(status).toBe(200);
    expect(b).toEqual({ status: "paid", eventId: 8, method: "mbw", amountCents: 1500 });
    expect(refreshOrderFromEasypay).not.toHaveBeenCalled();
  });

  it("should return 404 for an unknown or malformed order id", async () => {
    orderFindFirst.mockResolvedValue(undefined);
    expect((await testJson(`/api/teachings/orders/${PUBLIC_ID}`)).status).toBe(404);
    expect((await testJson("/api/teachings/orders/not-a-uuid")).status).toBe(404);
  });

  it("should show the Multibanco reference while the order is pending", async () => {
    orderFindFirst.mockResolvedValue(order);
    lookupSinglePayment.mockResolvedValue({ paymentId: "p", status: "pending", key: null, amountCents: 1500, methodType: "MB", entity: "11683", reference: "663000450" });
    const { body: b } = await testJson(`/api/teachings/orders/${PUBLIC_ID}`);
    expect(b).toEqual({
      status: "pending",
      eventId: 8,
      method: "mb",
      amountCents: 1500,
      mbReference: { entity: "11683", reference: "663000450", amount: 15 },
    });
  });

  it("should re-read Easypay and report paid when a pending order is older than 10 seconds", async () => {
    const old = { ...order, createdAt: new Date(Date.now() - 60_000) };
    orderFindFirst.mockResolvedValueOnce(old).mockResolvedValueOnce({ ...old, status: "paid", method: "mbw" });
    const { body: b } = await testJson(`/api/teachings/orders/${PUBLIC_ID}`);
    expect(refreshOrderFromEasypay).toHaveBeenCalledTimes(1);
    expect(b.status).toBe("paid");
  });

  it("should not hit Easypay refresh for a pending order younger than 10 seconds", async () => {
    orderFindFirst.mockResolvedValue(order);
    await testJson(`/api/teachings/orders/${PUBLIC_ID}`);
    expect(refreshOrderFromEasypay).not.toHaveBeenCalled();
  });
});

describe("GET /api/teachings/mine", () => {
  it("should require authentication", async () => {
    expect((await testJson("/api/teachings/mine")).status).toBe(401);
  });

  it("should list granted published events, newest grant first, dropping drafts", async () => {
    const token = await createAccessToken({ sub: 3, email: "buyer@example.com", role: "user" });
    grantFindMany.mockResolvedValue([
      { eventId: 1, createdAt: new Date("2026-01-01") },
      { eventId: 2, createdAt: new Date("2026-03-01") },
      { eventId: 3, createdAt: new Date("2026-02-01") },
    ]);
    eventFindMany.mockResolvedValue([
      { id: 1, status: "published", sessions: [], eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventOrganizers: [], videos: [], eventPublications: [] },
      { id: 2, status: "published", sessions: [], eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventOrganizers: [], videos: [], eventPublications: [] },
      { id: 3, status: "draft", sessions: [], eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventOrganizers: [], videos: [], eventPublications: [] },
    ]);
    const { status, body: b } = await testJson("/api/teachings/mine", { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expect(b.map((e: { id: number }) => e.id)).toEqual([2, 1]);
  });

  it("should return an empty list when the user has no grants", async () => {
    const token = await createAccessToken({ sub: 3, email: "buyer@example.com", role: "user" });
    grantFindMany.mockResolvedValue([]);
    const { body: b } = await testJson("/api/teachings/mine", { headers: { Authorization: `Bearer ${token}` } });
    expect(b).toEqual([]);
    expect(eventFindMany).not.toHaveBeenCalled();
  });
});
