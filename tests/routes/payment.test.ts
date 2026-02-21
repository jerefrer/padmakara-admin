import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

// Mock the database module before importing anything that uses it
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    update: vi.fn(),
  },
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

function mockUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    email: "user@test.com",
    firstName: "Test",
    lastName: "User",
    role: "user",
    isActive: true,
    subscriptionStatus: "none",
    subscriptionSource: null,
    easypaySubscriptionId: null,
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

async function authHeader(overrides: Record<string, any> = {}) {
  const token = await createAccessToken({
    sub: overrides.sub ?? 1,
    email: overrides.email ?? "user@test.com",
    role: overrides.role ?? "user",
  });
  return { Authorization: `Bearer ${token}` };
}

describe("Payment routes (mock mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Auth ───

  describe("Authentication", () => {
    it("returns 401 for subscribe without auth", async () => {
      const { status } = await testJson("/api/payment/subscribe", {
        method: "POST",
      });
      expect(status).toBe(401);
    });

    it("returns 401 for cancel without auth", async () => {
      const { status } = await testJson("/api/payment/cancel", {
        method: "POST",
      });
      expect(status).toBe(401);
    });
  });

  // ─── POST /api/payment/subscribe ───

  describe("POST /api/payment/subscribe", () => {
    it("returns 404 when user not found", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
      });

      expect(status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("returns 400 when already subscribed", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active" }),
      );

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
      });

      expect(status).toBe(400);
      expect(body.error).toBe("You already have an active subscription");
    });

    it("activates subscription in mock mode", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
      });

      expect(status).toBe(200);
      expect(body.url).toContain("/subscription/success");
      expect(body.url).toContain("session_id=mock_session");

      // Verify DB was updated
      expect(db.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionStatus: "active",
          subscriptionSource: "easypay",
          easypaySubscriptionId: "mock_sub_1",
        }),
      );
    });

    it("sets expiry ~30 days from now", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      await testJson("/api/payment/subscribe", { method: "POST", headers });

      const setArg = updateChain.set.mock.calls[0][0];
      const expiresAt = new Date(setArg.subscriptionExpiresAt);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(27);
      expect(diffDays).toBeLessThan(32);
    });

    it("allows subscription after expiry", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "expired" }),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
      });

      expect(status).toBe(200);
      expect(body.url).toContain("/subscription/success");
    });
  });

  // ─── POST /api/payment/cancel ───

  describe("POST /api/payment/cancel", () => {
    it("returns 404 when user not found", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const headers = await authHeader();
      const { status } = await testJson("/api/payment/cancel", {
        method: "POST",
        headers,
      });

      expect(status).toBe(404);
    });

    it("cancels subscription in mock mode", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active", easypaySubscriptionId: "mock_sub_1" }),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/cancel", {
        method: "POST",
        headers,
      });

      expect(status).toBe(200);
      expect(body.url).toContain("/subscription/cancel");

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionStatus: "expired",
        }),
      );
    });
  });

  // ─── POST /api/payment/webhook ───

  describe("POST /api/payment/webhook", () => {
    it("returns received:true in mock mode", async () => {
      const { status, body } = await testJson("/api/payment/webhook", {
        method: "POST",
        body: JSON.stringify({ id: "test", type: "subscription", status: "active" }),
      });

      expect(status).toBe(200);
      expect(body.received).toBe(true);
      expect(body.mock).toBe(true);
    });
  });

  // ─── GET /api/payment/checkout/:id ───

  describe("GET /api/payment/checkout/:id", () => {
    it("returns HTML with Easypay SDK", async () => {
      const res = await testRequest(
        "/api/payment/checkout/test-id?session=test-session&userId=1",
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("easypayCheckout.startCheckout");
      expect(html).toContain("cdn.easypay.pt/checkout");
      expect(html).toContain("Padmakara");
    });

    it("returns 400 without session parameter", async () => {
      const res = await testRequest("/api/payment/checkout/test-id");
      expect(res.status).toBe(400);
    });
  });

  // ─── Full lifecycle ───

  describe("Subscription lifecycle", () => {
    it("subscribe → cancel → re-subscribe", async () => {
      const headers = await authHeader();

      // 1. Subscribe
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());
      let updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      let res = await testJson("/api/payment/subscribe", { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("success");
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionStatus: "active" }),
      );

      // 2. Cancel
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active", easypaySubscriptionId: "mock_sub_1" }),
      );
      updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      res = await testJson("/api/payment/cancel", { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("cancel");
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionStatus: "expired" }),
      );

      // 3. Re-subscribe
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "expired" }),
      );
      updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      res = await testJson("/api/payment/subscribe", { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("success");
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionStatus: "active" }),
      );
    });
  });
});
