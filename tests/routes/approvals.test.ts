import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// Mock the database module before importing anything that uses it
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      userApprovalRequests: { findFirst: vi.fn(), findMany: vi.fn() },
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
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
import { createAccessToken } from "../../src/services/auth.ts";
import { sendEmail } from "../../src/services/email.ts";

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

function mockInsertChain(returning?: any[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning ?? []),
  };
  return chain;
}

function mockCountChain(count: number) {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count }]),
    }),
  });
}

async function adminHeader() {
  const token = await createAccessToken({
    sub: 100,
    email: "admin@test.com",
    role: "admin",
  });
  return { Authorization: `Bearer ${token}` };
}

async function userHeader() {
  const token = await createAccessToken({
    sub: 1,
    email: "user@test.com",
    role: "user",
  });
  return { Authorization: `Bearer ${token}` };
}

function mockApprovalRequest(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    email: "new@test.com",
    firstName: "New",
    lastName: "User",
    message: "Please let me in",
    status: "pending",
    adminMessage: null,
    deviceFingerprint: "fp-123",
    deviceName: "iPhone",
    deviceType: "ios",
    language: "en",
    requestedAt: new Date(),
    reviewedAt: null,
    reviewedById: null,
    reviewedBy: null,
    ...overrides,
  };
}

describe("Admin approval routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Auth & Authorization ───

  describe("Authorization", () => {
    it("returns 401 without auth header", async () => {
      const { status } = await testJson("/api/admin/approvals");
      expect(status).toBe(401);
    });

    it("returns 403 for non-admin user", async () => {
      const headers = await userHeader();
      const { status, body } = await testJson("/api/admin/approvals", {
        headers,
      });
      expect(status).toBe(403);
      expect(body.error).toBe("Admin access required");
    });
  });

  // ─── GET /api/admin/approvals ───

  describe("GET /api/admin/approvals", () => {
    it("returns list of approval requests", async () => {
      const requests = [
        mockApprovalRequest({ id: 1, status: "pending" }),
        mockApprovalRequest({ id: 2, status: "approved", email: "other@test.com" }),
      ];

      (db.query.userApprovalRequests.findMany as any).mockResolvedValue(requests);
      (db.select as any) = mockCountChain(2);

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals?_start=0&_end=25&_sort=id&_order=ASC",
        { headers },
      );

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].email).toBe("new@test.com");
    });
  });

  // ─── GET /api/admin/approvals/:id ───

  describe("GET /api/admin/approvals/:id", () => {
    it("returns single approval request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest(),
      );

      const headers = await adminHeader();
      const { status, body } = await testJson("/api/admin/approvals/1", {
        headers,
      });

      expect(status).toBe(200);
      expect(body.email).toBe("new@test.com");
      expect(body.status).toBe("pending");
    });

    it("returns 404 for non-existent request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(null);

      const headers = await adminHeader();
      const { status, body } = await testJson("/api/admin/approvals/999", {
        headers,
      });

      expect(status).toBe(404);
      expect(body.error).toBe("Approval request not found");
    });
  });

  // ─── POST /api/admin/approvals/:id/approve ───

  describe("POST /api/admin/approvals/:id/approve", () => {
    it("approves request, creates user, sends email", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest(),
      );
      // No existing user
      (db.query.users.findFirst as any).mockResolvedValue(null);

      // Insert new user
      const insertChain = mockInsertChain([{ id: 5 }]);
      (db.insert as any).mockReturnValue(insertChain);

      // Update approval request
      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/approve",
        { method: "POST", headers },
      );

      expect(status).toBe(200);
      expect(body.message).toContain("approved");
      expect(body.userId).toBe(5);

      // User was created
      expect(db.insert).toHaveBeenCalled();

      // Email was sent
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@test.com" }),
      );
    });

    it("reuses existing user if email already exists", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest(),
      );
      // User already exists
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 3,
        email: "new@test.com",
        isActive: false,
      });

      const insertChain = mockInsertChain();
      (db.insert as any).mockReturnValue(insertChain);

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/approve",
        { method: "POST", headers },
      );

      expect(status).toBe(200);
      expect(body.userId).toBe(3);
    });

    it("returns 404 for non-existent request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(null);

      const headers = await adminHeader();
      const { status } = await testJson("/api/admin/approvals/999/approve", {
        method: "POST",
        headers,
      });

      expect(status).toBe(404);
    });

    it("returns 400 for already-approved request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest({ status: "approved" }),
      );

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/approve",
        { method: "POST", headers },
      );

      expect(status).toBe(400);
      expect(body.error).toBe("Request already approved");
    });

    it("returns 400 for already-rejected request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest({ status: "rejected" }),
      );

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/approve",
        { method: "POST", headers },
      );

      expect(status).toBe(400);
      expect(body.error).toBe("Request already rejected");
    });
  });

  // ─── POST /api/admin/approvals/:id/reject ───

  describe("POST /api/admin/approvals/:id/reject", () => {
    it("rejects request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest(),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/reject",
        { method: "POST", headers },
      );

      expect(status).toBe(200);
      expect(body.message).toContain("rejected");
    });

    it("stores admin message on rejection", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest(),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await adminHeader();
      await testJson("/api/admin/approvals/1/reject", {
        method: "POST",
        headers,
        body: JSON.stringify({ adminMessage: "Not a retreat member" }),
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "rejected",
          adminMessage: "Not a retreat member",
          reviewedById: 100,
        }),
      );
    });

    it("returns 404 for non-existent request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(null);

      const headers = await adminHeader();
      const { status } = await testJson("/api/admin/approvals/999/reject", {
        method: "POST",
        headers,
      });

      expect(status).toBe(404);
    });

    it("returns 400 for already-processed request", async () => {
      (db.query.userApprovalRequests.findFirst as any).mockResolvedValue(
        mockApprovalRequest({ status: "rejected" }),
      );

      const headers = await adminHeader();
      const { status, body } = await testJson(
        "/api/admin/approvals/1/reject",
        { method: "POST", headers },
      );

      expect(status).toBe(400);
      expect(body.error).toBe("Request already rejected");
    });
  });
});
