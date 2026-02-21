import { describe, it, expect, vi, beforeEach } from "vitest";
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

    it("returns approval_required for unknown user", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({ email: "unknown@test.com", ...devicePayload }),
      });

      expect(status).toBe(200);
      expect(body.status).toBe("approval_required");
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

  describe("POST /api/auth/verify-magic-link", () => {
    it("returns 401 for invalid token", async () => {
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/verify-magic-link", {
        method: "POST",
        body: JSON.stringify({ token: "invalid-token" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBe("Invalid or expired magic link");
    });

    it("creates new user for first-time magic link login", async () => {
      const token = "valid-magic-link-token";
      const tokenHash = await hashToken(token);

      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue({
        id: 1,
        email: "new@test.com",
        tokenHash,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Mark token as used
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      // User doesn't exist yet
      (db.query.users.findFirst as any).mockResolvedValue(null);

      // Insert new user
      const insertChain = mockInsertChain([{
        id: 5,
        email: "new@test.com",
        firstName: null,
        lastName: null,
        isActive: true,
        isVerified: true,
        role: "user",
      }]);
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/verify-magic-link", {
        method: "POST",
        body: JSON.stringify({ token }),
      });

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.user.email).toBe("new@test.com");
    });

    it("returns tokens for existing user", async () => {
      const token = "valid-magic-link-token";
      const tokenHash = await hashToken(token);

      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue({
        id: 1,
        email: "existing@test.com",
        tokenHash,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      (db.query.users.findFirst as any).mockResolvedValue({
        id: 3,
        email: "existing@test.com",
        firstName: "Existing",
        lastName: "User",
        isActive: true,
        isVerified: true,
        role: "user",
      });

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/verify-magic-link", {
        method: "POST",
        body: JSON.stringify({ token }),
      });

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
      expect(body.user.id).toBe(3);
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
