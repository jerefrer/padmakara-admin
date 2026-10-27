import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../helpers.ts";

// Mock the database module before importing anything that uses it
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      refreshTokens: { findFirst: vi.fn() },
      magicLinkTokens: { findFirst: vi.fn() },
      deviceActivations: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      userApprovalRequests: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock email service
vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildMagicLinkEmail: vi.fn().mockReturnValue({
    subject: "Your login link",
    html: "<p>Click here</p>",
  }),
}));

import { db } from "../../src/db/index.ts";
import { config } from "../../src/config.ts";
import {
  hashPassword,
  createAccessToken,
  createRefreshToken,
  hashToken,
} from "../../src/services/auth.ts";

// Helper to create mock chain for insert/update/delete
function mockInsertChain(returning?: any[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning ?? []),
  };
  return chain;
}

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

function mockDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

describe("Auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/auth/login", () => {
    it("returns 401 for non-existent user", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "nobody@test.com", password: "password123" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid email or password");
    });

    it("returns 401 for user without password (magic-link-only user)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "user@test.com",
        passwordHash: null,
        isActive: true,
        role: "user",
      });

      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", password: "password123" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid email or password");
    });

    it("returns 401 for wrong password", async () => {
      const hash = await hashPassword("correct-password");
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "admin@test.com",
        passwordHash: hash,
        isActive: true,
        role: "admin",
      });

      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@test.com", password: "wrong-password" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid email or password");
    });

    it("returns 401 for deactivated user", async () => {
      const hash = await hashPassword("password123");
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "admin@test.com",
        passwordHash: hash,
        isActive: false,
        role: "admin",
      });

      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@test.com", password: "password123" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Account is deactivated");
    });

    it("returns tokens and user on successful login", async () => {
      const hash = await hashPassword("password123");
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "admin@test.com",
        passwordHash: hash,
        firstName: "Admin",
        lastName: "User",
        isActive: true,
        role: "admin",
      });

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@test.com", password: "password123" }),
      });

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.user.id).toBe(1);
      expect(body.user.email).toBe("admin@test.com");
      expect(body.user.role).toBe("admin");
      // Verify refresh token was stored
      expect(db.insert).toHaveBeenCalled();
    });

    it("returns 400 for missing email", async () => {
      const { status, body } = await testJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: "password123" }),
      });

      expect(status).toBe(400);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues).toBeDefined();
    });
  });

  describe("POST /api/auth/request-magic-link", () => {
    const devicePayload = {
      device_fingerprint: "test-fingerprint-abc123",
      device_name: "Test Device",
      device_type: "ios",
    };

    it("sends magic link email and returns success", async () => {
      // Mock: user exists, device not activated
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1, email: "user@test.com", isActive: true, role: "user",
      });
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(null);

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { sendEmail } = await import("../../src/services/email.ts");

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(body.status).toBe("magic_link_sent");
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "user@test.com" }),
      );
    });

    it("accepts language parameter", async () => {
      // Mock: user exists, device not activated
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1, email: "user@test.com", isActive: true, role: "user",
      });
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(null);

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { buildMagicLinkEmail } = await import("../../src/services/email.ts");

      const { status } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", language: "pt", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(buildMagicLinkEmail).toHaveBeenCalledWith(
        expect.stringContaining("activate/"),
        "pt",
      );
    });

    it("returns magic_link_sent for unknown user (no account enumeration)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "unknown@test.com", ...devicePayload }),
      });

      expect(status).toBe(200);
      // Must NOT distinguish known vs unknown email — same shape in both cases.
      expect(body.status).toBe("magic_link_sent");
      expect(body).not.toHaveProperty("email"); // no address leakage
    });

    it("returns already_activated for activated device", async () => {
      const mockUser = {
        id: 1, email: "user@test.com", firstName: "Test", lastName: "User",
        dharmaName: null, preferredLanguage: "en", role: "user",
        isActive: true, isVerified: true,
        subscriptionStatus: "none", subscriptionSource: null, subscriptionExpiresAt: null,
        lastActivity: new Date(), createdAt: new Date(),
      };
      (db.query.users.findFirst as any).mockResolvedValue(mockUser);
      (db.query.deviceActivations.findFirst as any).mockResolvedValue({
        id: 1, userId: 1, deviceFingerprint: devicePayload.device_fingerprint,
        isActive: true,
      });

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(body.status).toBe("already_activated");
      expect(body.access_token).toBeDefined();
      expect(body.user).toBeDefined();
    });
  });

  describe("store-review demo account", () => {
    const review = config.review as { email: string; code: string };
    const original = { ...review };
    const devicePayload = {
      device_fingerprint: "review-fingerprint-1",
      device_name: "Reviewer iPhone",
      device_type: "ios",
    };
    const reviewUser = {
      id: 7, email: "review@padmakara.pt", firstName: "App", lastName: "Review",
      dharmaName: null, preferredLanguage: "en", role: "user",
      isActive: true, isVerified: false,
      subscriptionStatus: "none", subscriptionSource: null, subscriptionExpiresAt: null,
      lastActivity: null, createdAt: new Date(),
    };

    beforeEach(() => {
      review.email = "review@padmakara.pt";
      review.code = "demo-code-1";
      (db.insert as any).mockReturnValue(mockInsertChain());
      (db.update as any).mockReturnValue(mockUpdateChain());
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(null);
    });

    afterEach(() => {
      review.email = original.email;
      review.code = original.code;
    });

    it("request-magic-link returns code_required for the review email without sending email", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(reviewUser);
      const { sendEmail } = await import("../../src/services/email.ts");

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "Review@Padmakara.pt", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(body.status).toBe("code_required");
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("request-magic-link sends the normal magic link for other emails even when configured", async () => {
      (db.query.users.findFirst as any).mockResolvedValue({ ...reviewUser, id: 1, email: "user@test.com" });
      const { sendEmail } = await import("../../src/services/email.ts");

      const { body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", ...devicePayload }),
      });

      expect(body.status).toBe("magic_link_sent");
      expect(sendEmail).toHaveBeenCalled();
    });

    it("request-magic-link is unchanged for the review email when no code is configured", async () => {
      review.code = "";
      (db.query.users.findFirst as any).mockResolvedValue(reviewUser);
      const { sendEmail } = await import("../../src/services/email.ts");

      const { body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", ...devicePayload }),
      });

      expect(body.status).toBe("magic_link_sent");
      expect(sendEmail).toHaveBeenCalled();
    });

    it("request-magic-link keeps the generic response when the review user does not exist", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const { body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", ...devicePayload }),
      });

      expect(body.status).toBe("magic_link_sent");
    });

    it("review-login activates the device and returns tokens with the already_activated shape", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(reviewUser);
      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/review-login", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", code: "demo-code-1", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(body.status).toBe("already_activated");
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toBeDefined();
      expect(body.user.email).toBe("review@padmakara.pt");
      // A device activation row was created for this fingerprint.
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 7, deviceFingerprint: "review-fingerprint-1" }),
      );
    });

    it("review-login is wired with the same limiters as request-magic-link", async () => {
      const { auth: authRoutes } = await import("../../src/routes/auth.ts");
      const count = (path: string) =>
        authRoutes.routes.filter((r: any) => r.method === "POST" && r.path === path).length;
      // IP limiter + email limiter + handler, same as request-magic-link.
      expect(count("/review-login")).toBe(3);
      expect(count("/review-login")).toBe(count("/request-magic-link"));
    });

    it("review-login returns 401 for a wrong code", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(reviewUser);

      const { status } = await testJson("/api/auth/review-login", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", code: "wrong", ...devicePayload }),
      });

      expect(status).toBe(401);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("review-login returns 401 for any other email, even with the right code", async () => {
      (db.query.users.findFirst as any).mockResolvedValue({ ...reviewUser, id: 1, email: "user@test.com" });

      const { status } = await testJson("/api/auth/review-login", {
        method: "POST",
        body: JSON.stringify({ email: "user@test.com", code: "demo-code-1", ...devicePayload }),
      });

      expect(status).toBe(401);
    });

    it("review-login returns 401 when the feature is disabled", async () => {
      review.code = "";
      (db.query.users.findFirst as any).mockResolvedValue(reviewUser);

      const { status } = await testJson("/api/auth/review-login", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", code: "demo-code-1", ...devicePayload }),
      });

      expect(status).toBe(401);
    });

    it("review-login returns 401 when the review user is missing or deactivated", async () => {
      (db.query.users.findFirst as any).mockResolvedValue({ ...reviewUser, isActive: false });

      const { status } = await testJson("/api/auth/review-login", {
        method: "POST",
        body: JSON.stringify({ email: "review@padmakara.pt", code: "demo-code-1", ...devicePayload }),
      });

      expect(status).toBe(401);
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("returns 401 for invalid JWT refresh token", async () => {
      const { status, body } = await testJson("/api/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: "not-a-jwt" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid refresh token");
    });

    it("returns 401 for refresh token not in database", async () => {
      // Create a real refresh token JWT
      const rt = await createRefreshToken({ sub: 1, email: "test@test.com", role: "user" });

      (db.query.refreshTokens.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: rt }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid or expired refresh token");
    });

    it("rotates tokens on successful refresh", async () => {
      const rt = await createRefreshToken({ sub: 1, email: "test@test.com", role: "user" });
      const rtHash = await hashToken(rt);

      (db.query.refreshTokens.findFirst as any).mockResolvedValue({
        id: 10,
        userId: 1,
        tokenHash: rtHash,
        expiresAt: new Date(Date.now() + 86400000),
      });

      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "test@test.com",
        isActive: true,
        role: "user",
      });

      const deleteChain = mockDeleteChain();
      (db.delete as any).mockReturnValue(deleteChain);

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: rt }),
      });

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      // Old token was deleted (rotation)
      expect(db.delete).toHaveBeenCalled();
      // New token was inserted
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns 401 without auth header", async () => {
      const { status, body } = await testJson("/api/auth/me");

      expect(status).toBe(401);
      expect(body.error).toBe("Missing or invalid Authorization header");
    });

    it("returns 401 with invalid token", async () => {
      const { status } = await testJson("/api/auth/me", {
        headers: { Authorization: "Bearer invalid-token" },
      });

      expect(status).toBe(401);
    });

    it("returns user profile with valid token", async () => {
      const token = await createAccessToken({
        sub: 1,
        email: "admin@test.com",
        role: "admin",
      });

      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "admin@test.com",
        firstName: "Admin",
        lastName: "User",
        dharmaName: null,
        preferredLanguage: "en",
        role: "admin",
        isVerified: true,
        createdAt: new Date("2024-01-01"),
      });

      const { status, body } = await testJson("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(body.id).toBe(1);
      expect(body.email).toBe("admin@test.com");
      expect(body.role).toBe("admin");
      expect(body.firstName).toBe("Admin");
    });
  });

  describe("GET /api/auth/me subscription", () => {
    async function meWith(expiredDaysAgo: number) {
      const token = await createAccessToken({ sub: 1, email: "m@test.com", role: "user" });
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        email: "m@test.com",
        firstName: "M",
        lastName: "U",
        dharmaName: null,
        preferredLanguage: "en",
        role: "user",
        isVerified: true,
        createdAt: new Date("2024-01-01"),
        subscriptionStatus: "active",
        subscriptionSource: "easypay",
        subscriptionExpiresAt: new Date(Date.now() - expiredDaysAgo * 86400000),
        subscriptionCancelledAt: null,
        subscriptionAmount: "5.00",
      });
      return testJson("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    }

    it("should report hasAccess true when access expired 3 days ago (grace)", async () => {
      const { body } = await meWith(3);
      expect(body.subscription).toMatchObject({ status: "active", hasAccess: true, amount: 5, cancelledAt: null });
    });

    it("should report hasAccess false when access expired 30 days ago", async () => {
      const { body } = await meWith(30);
      expect(body.subscription.hasAccess).toBe(false);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("returns 401 without auth header", async () => {
      const { status } = await testJson("/api/auth/logout", {
        method: "POST",
      });

      expect(status).toBe(401);
    });

    it("deletes specific refresh token when provided", async () => {
      const accessToken = await createAccessToken({
        sub: 1,
        email: "admin@test.com",
        role: "admin",
      });

      const deleteChain = mockDeleteChain();
      (db.delete as any).mockReturnValue(deleteChain);

      const { status, body } = await testJson("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ refreshToken: "some-refresh-token" }),
      });

      expect(status).toBe(200);
      expect(body.message).toBe("Logged out");
      expect(db.delete).toHaveBeenCalled();
    });

    it("deletes all refresh tokens when no specific token provided", async () => {
      const accessToken = await createAccessToken({
        sub: 1,
        email: "admin@test.com",
        role: "admin",
      });

      const deleteChain = mockDeleteChain();
      (db.delete as any).mockReturnValue(deleteChain);

      const { status, body } = await testJson("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(status).toBe(200);
      expect(body.message).toBe("Logged out");
    });
  });
});
