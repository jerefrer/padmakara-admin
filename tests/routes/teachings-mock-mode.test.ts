import { describe, it, expect, vi, beforeEach } from "vitest";

/** Mock mode: no EASYPAY_ACCOUNT_ID, so no Easypay call is made and the order is paid at once. */
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "";
});

const insertValues = vi.fn();
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: {
        findFirst: vi.fn(async () => ({
          id: 8, titleEn: "T", titlePt: "T", status: "published", saleMode: "paid", priceCents: 1500,
          audience: null,
        })),
      },
      users: { findFirst: vi.fn(async () => ({ id: 3, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null })) },
    },
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        insertValues(v);
        return { returning: () => Promise.resolve([{ id: 5, publicId: "11111111-1111-1111-1111-111111111111" }]) };
      },
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  },
}));
vi.mock("../../src/services/users-lookup.ts", () => ({
  findOrCreateUserByEmail: vi.fn(async () => ({ user: { id: 3, email: "b@example.com", preferredLanguage: "pt" }, created: false })),
}));
vi.mock("../../src/services/access.ts", async (orig) => ({
  ...(await orig<object>()),
  hasEventGrant: vi.fn(async () => false),
  checkEventAccess: vi.fn(async () => ({ allowed: false, reason: "ACCESS_DENIED" })),
}));
const finalizeOrder = vi.fn(async () => "finalized");
vi.mock("../../src/services/teaching-orders.ts", async (orig) => ({
  ...(await orig<object>()),
  finalizeOrder: (...a: unknown[]) => finalizeOrder(...(a as [])),
}));

import { testJson } from "../helpers.ts";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/teachings/:eventId/checkout (mock mode)", () => {
  it("should mark the order paid immediately and never call Easypay", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { status, body } = await testJson("/api/teachings/8/checkout", {
      method: "POST",
      body: JSON.stringify({ email: "b@example.com", firstName: "A", lastName: "B", language: "en", consent: true }),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "checkout", orderId: "11111111-1111-1111-1111-111111111111", checkout: { id: "mock_session" } });
    expect(finalizeOrder).toHaveBeenCalledWith(5, expect.objectContaining({ amountCents: 1500 }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
