import { describe, it, expect, vi } from "vitest";

/** Production without an Easypay account must fail closed, never mark orders paid. */
vi.hoisted(() => {
  process.env.NODE_ENV = "production";
  process.env.EASYPAY_ACCOUNT_ID = "";
  process.env.READ_ALONG_WEBHOOK_SECRET = "prod-like-secret-for-test";
});

const insertValues = vi.fn();
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: {
        findFirst: vi.fn(async () => ({
          id: 8, titleEn: "T", titlePt: "T", status: "published", saleMode: "paid", priceCents: 1500, audience: null,
        })),
      },
      users: { findFirst: vi.fn(async () => ({ id: 3, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null })) },
    },
    insert: vi.fn(() => ({ values: (v: unknown) => { insertValues(v); return { returning: () => Promise.resolve([{ id: 5, publicId: "p" }]) }; } })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  },
}));
const findOrCreateUserByEmail = vi.fn(async () => ({ user: { id: 3, email: "b@example.com", preferredLanguage: "pt" }, created: false }));
vi.mock("../../src/services/users-lookup.ts", () => ({
  findOrCreateUserByEmail: (...a: unknown[]) => (findOrCreateUserByEmail as any)(...a),
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

describe("POST /api/teachings/:eventId/checkout in production without Easypay", () => {
  it("should answer 503, create no order and finalize nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status } = await testJson("/api/teachings/8/checkout", {
      method: "POST",
      body: JSON.stringify({ email: "b@example.com", firstName: "A", lastName: "B", language: "en", consent: true }),
    });
    expect(status).toBe(503);
    expect(finalizeOrder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(findOrCreateUserByEmail).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
