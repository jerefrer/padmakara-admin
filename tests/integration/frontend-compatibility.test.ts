import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";
import { createAccessToken, hashPassword, hashToken } from "../../src/services/auth.ts";

/**
 * Frontend Compatibility Integration Tests
 *
 * These tests verify that the Hono+Drizzle backend (padmakara-api) maintains
 * full compatibility with the React Native app (padmakara-app) expectations.
 *
 * The app expects specific response formats, field names, and behaviors that
 * were originally implemented in the Django backend (padmakara-backend).
 */

// Mock the database module before importing anything that uses it
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      refreshTokens: { findFirst: vi.fn() },
      magicLinkTokens: { findFirst: vi.fn() },
      deviceActivations: { findFirst: vi.fn(), findMany: vi.fn() },
      userApprovalRequests: { findFirst: vi.fn() },
      userGroupMemberships: { findMany: vi.fn().mockResolvedValue([]) },
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

// Helper to create mock chain for insert/update/delete
function mockInsertChain(returning?: any[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning ?? []),
  };
  return chain;
}

function mockUpdateChain(returning?: any[]) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning ?? []),
  };
  return chain;
}

function mockDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

describe("Frontend Compatibility Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Magic Link Flow Compatibility", () => {
    const mockUser = {
      id: 1,
      email: "user@test.com",
      firstName: "John",
      lastName: "Doe",
      dharmaName: "Dharma Practitioner",
      preferredLanguage: "en",
      role: "user",
      isActive: true,
      isVerified: true,
      subscriptionStatus: "active",
      subscriptionSource: "admin",
      subscriptionExpiresAt: new Date("2099-12-31"),
      lastActivity: new Date(),
      createdAt: new Date(),
    };

    const devicePayload = {
      email: "user@test.com",
      device_fingerprint: "test-fingerprint-12345",
      device_name: "iPhone 14 Pro",
      device_type: "ios",
      language: "en",
    };

    it("should return correct response format for request-magic-link (already_activated)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser);
      (db.query.deviceActivations.findFirst as any).mockResolvedValue({
        id: 1,
        userId: mockUser.id,
        deviceFingerprint: devicePayload.device_fingerprint,
        isActive: true,
        activatedAt: new Date(),
        lastUsed: new Date(),
      });

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify(devicePayload),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "already_activated",
        message: expect.any(String),
        access_token: expect.any(String),
        refresh_token: expect.any(String),
        user: expect.objectContaining({
          id: expect.any(String), // App expects string IDs
          name: expect.any(String),
          email: mockUser.email,
          dharma_name: mockUser.dharmaName,
          preferences: expect.objectContaining({
            language: expect.any(String),
            contentLanguage: expect.any(String),
            biometricEnabled: expect.any(Boolean),
            notifications: expect.any(Boolean),
          }),
          subscription: expect.objectContaining({
            status: expect.any(String),
          }),
        }),
      });
    });

    it("should return correct response format for request-magic-link (magic_link_sent)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser);
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(null); // Device not activated

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify(devicePayload),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "magic_link_sent",
        message: expect.any(String),
        expires_in: expect.any(Number),
      });
    });

    it("should return correct response format for request-magic-link (approval_required)", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null); // User doesn't exist

      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify(devicePayload),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "approval_required",
        message: expect.any(String),
        email: devicePayload.email,
      });
    });

    it("should handle device discovery endpoint correctly", async () => {
      (db.query.deviceActivations.findFirst as any).mockResolvedValue({
        id: 1,
        userId: mockUser.id,
        deviceFingerprint: devicePayload.device_fingerprint,
        deviceName: devicePayload.device_name,
        isActive: true,
        activatedAt: new Date(),
        lastUsed: new Date(),
      });
      (db.query.users.findFirst as any).mockResolvedValue(mockUser);

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/device/discover", {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: devicePayload.device_fingerprint,
        }),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "activated",
        message: expect.any(String),
        access_token: expect.any(String),
        refresh_token: expect.any(String),
        user: expect.objectContaining({
          id: expect.any(String),
          email: mockUser.email,
        }),
        device: expect.objectContaining({
          activated_at: expect.any(String),
          device_fingerprint: devicePayload.device_fingerprint,
          device_name: devicePayload.device_name,
          user_name: expect.any(String),
          is_active: true,
        }),
      });
    });

    it("should handle device discovery for non-activated device", async () => {
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(null);

      const { status, body } = await testJson("/api/auth/device/discover", {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: "unknown-device",
        }),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "not_activated",
        message: expect.any(String),
      });
    });
  });

  describe("User Profile Endpoint Compatibility", () => {
    const mockUser = {
      id: 1,
      email: "user@test.com",
      firstName: "Jane",
      lastName: "Smith",
      dharmaName: "Peaceful One",
      preferredLanguage: "pt",
      role: "user",
      isActive: true,
      isVerified: true,
      subscriptionStatus: "active",
      subscriptionSource: "admin",
      subscriptionExpiresAt: new Date("2099-12-31"),
      lastActivity: new Date(),
      createdAt: new Date(),
    };

    it("GET /api/auth/user should return formatted user for app", async () => {
      const token = await createAccessToken({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      (db.query.users.findFirst as any).mockResolvedValue(mockUser);

      const { status, body } = await testJson("/api/auth/user", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);

      // Verify the app-expected format
      expect(body).toMatchObject({
        id: expect.any(String), // App expects string IDs
        name: "Jane Smith", // Concatenated name
        email: mockUser.email,
        dharma_name: mockUser.dharmaName,
        retreat_groups: expect.any(Array),
        preferences: {
          language: mockUser.preferredLanguage,
          contentLanguage: "en",
          biometricEnabled: false,
          notifications: true,
        },
        subscription: {
          status: "active",
          source: "admin",
          expiresAt: expect.any(String),
        },
        created_at: expect.any(String),
        last_login: expect.any(String),
      });
    });

    it("PATCH /api/auth/user should accept snake_case and camelCase fields", async () => {
      const token = await createAccessToken({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      const updatedUser = {
        ...mockUser,
        firstName: "Updated",
        lastName: "Name",
        dharmaName: "New Dharma Name",
      };

      (db.query.users.findFirst as any).mockResolvedValue(mockUser);
      const updateChain = mockUpdateChain([updatedUser]);
      (db.update as any).mockReturnValue(updateChain);

      // Test with snake_case (app sends both formats)
      const { status: status1, body: body1 } = await testJson("/api/auth/user", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          first_name: "Updated",
          last_name: "Name",
          dharma_name: "New Dharma Name",
        }),
      });

      expect(status1).toBe(200);
      expect(body1.name).toBe("Updated Name");
      expect(body1.dharma_name).toBe("New Dharma Name");

      // Test with camelCase
      const { status: status2, body: body2 } = await testJson("/api/auth/user", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          firstName: "Updated",
          lastName: "Name",
          dharmaName: "New Dharma Name",
        }),
      });

      expect(status2).toBe(200);
      expect(body2.name).toBe("Updated Name");
    });

    it("PATCH /api/auth/user should update language preference", async () => {
      const token = await createAccessToken({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      const updatedUser = {
        ...mockUser,
        preferredLanguage: "pt",
      };

      (db.query.users.findFirst as any).mockResolvedValue(mockUser);
      const updateChain = mockUpdateChain([updatedUser]);
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/user", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          preferences: {
            language: "pt",
          },
        }),
      });

      expect(status).toBe(200);
      expect(body.preferences.language).toBe("pt");
    });
  });

  describe("Device Management Compatibility", () => {
    const mockUser = {
      id: 1,
      email: "user@test.com",
      firstName: "Test",
      lastName: "User",
      role: "user",
    };

    it("GET /api/auth/devices should return devices in app-expected format", async () => {
      const token = await createAccessToken({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      const mockDevices = [
        {
          id: 1,
          deviceFingerprint: "device-1",
          deviceName: "iPhone 14",
          deviceType: "ios",
          activatedAt: new Date(),
          lastUsed: new Date(),
          isActive: true,
        },
        {
          id: 2,
          deviceFingerprint: "device-2",
          deviceName: "MacBook Pro",
          deviceType: "web",
          activatedAt: new Date(),
          lastUsed: new Date(),
          isActive: true,
        },
      ];

      (db.query.deviceActivations.findMany as any).mockResolvedValue(mockDevices);

      const { status, body } = await testJson("/api/auth/devices", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({
        id: expect.any(Number),
        device_fingerprint: "device-1",
        device_name: "iPhone 14",
        device_type: "ios",
        activated_at: expect.any(String),
        last_used: expect.any(String),
        is_active: true,
      });
    });

    it("POST /api/auth/device/deactivate should work with authenticated user", async () => {
      const token = await createAccessToken({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      (db.query.deviceActivations.findFirst as any).mockResolvedValue({
        id: 1,
        userId: mockUser.id,
        deviceFingerprint: "device-to-deactivate",
        isActive: true,
      });

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const { status, body } = await testJson("/api/auth/device/deactivate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_fingerprint: "device-to-deactivate",
        }),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "deactivated",
        message: expect.any(String),
      });
    });
  });

  describe("Approval Request Flow Compatibility", () => {
    it("POST /api/auth/request-approval should accept all required fields", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(null);

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const { status, body } = await testJson("/api/auth/request-approval", {
        method: "POST",
        body: JSON.stringify({
          email: "newuser@test.com",
          first_name: "New",
          last_name: "User",
          message: "I would like access to the retreat materials",
          device_fingerprint: "new-device-fp",
          device_name: "iPad Pro",
          device_type: "ios",
          language: "en",
        }),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "approval_requested",
        message: expect.any(String),
      });
    });

    it("POST /api/auth/request-approval should handle existing pending requests", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue({
        id: 1,
        email: "existing@test.com",
        status: "pending",
      });

      const { status, body } = await testJson("/api/auth/request-approval", {
        method: "POST",
        body: JSON.stringify({
          email: "existing@test.com",
          first_name: "Existing",
          last_name: "Request",
          device_fingerprint: "device-fp",
          device_name: "iPhone",
          device_type: "ios",
        }),
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "already_pending",
        message: expect.any(String),
      });
    });
  });

  describe("Token Validation Compatibility", () => {
    it("should accept tokens validated via GET /api/auth/devices endpoint", async () => {
      const token = await createAccessToken({
        sub: 1,
        email: "test@test.com",
        role: "user",
      });

      (db.query.deviceActivations.findMany as any).mockResolvedValue([]);

      // This is the endpoint the app uses for token validation
      const { status } = await testJson("/api/auth/devices", {
        headers: { Authorization: `Bearer ${token}` },
      });

      // 200 = valid token, 401 = invalid token
      expect(status).toBe(200);
    });

    it("should return 401 for invalid tokens on validation endpoint", async () => {
      const { status } = await testJson("/api/auth/devices", {
        headers: { Authorization: "Bearer invalid-token" },
      });

      expect(status).toBe(401);
    });
  });

  describe("Error Response Format Compatibility", () => {
    it("should return consistent error format for validation errors", async () => {
      // Missing required field
      const { status, body } = await testJson("/api/auth/request-magic-link", {
        method: "POST",
        body: JSON.stringify({
          // Missing email
          device_fingerprint: "test",
          device_name: "Test",
          device_type: "ios",
        }),
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({
        code: "VALIDATION_ERROR",
        issues: expect.any(Array),
      });
    });

    it("should return consistent error format for authentication errors", async () => {
      const { status, body } = await testJson("/api/auth/user", {
        // No auth header
      });

      expect(status).toBe(401);
      expect(body).toMatchObject({
        error: expect.any(String),
      });
    });
  });
});
