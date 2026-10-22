import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// Drives POST /api/events/:id/request-download (authenticated) and
// POST /api/events/public/:id/request-download (anonymous) through the real
// app. The access-control service runs for real; only the database, the ZIP
// generator and the storage presigner are mocked.

const { mockDb, insertedValues, mockGenerateRetreatZip } = vi.hoisted(() => {
  const insertedValues: Array<Record<string, unknown>> = [];
  const mockDb = {
    query: {
      events: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      downloadRequests: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
    },
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return { returning: vi.fn(() => Promise.resolve([{ id: "new-request-id", ...vals }])) };
      }),
    })),
  };
  const mockGenerateRetreatZip = vi.fn(
    (_requestId: string, _eventId: number, _userId?: number) => Promise.resolve(),
  );
  return { mockDb, insertedValues, mockGenerateRetreatZip };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/zip-generator.ts", () => ({
  generateRetreatZip: mockGenerateRetreatZip,
}));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://storage.example.test/x")),
}));

import { createAccessToken } from "../../src/services/auth.ts";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    status: "published",
    audience: { slug: "free-anyone" },
    eventRetreatGroups: [],
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: "user@test.com",
    role: "user",
    subscriptionStatus: "none",
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

async function authHeader(role = "user") {
  const token = await createAccessToken({ sub: 1, email: "user@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
});

describe("POST /api/events/:id/request-download", () => {
  it("should return 401 without a token", async () => {
    const { status } = await testJson("/api/events/42/request-download", { method: "POST" });

    expect(status).toBe(401);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("should create a user-owned request and start generation in the background", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUser());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);

    const { status, body } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ request_id: "new-request-id" });
    expect(insertedValues).toEqual([{ userId: 1, eventId: 42, status: "pending" }]);
    expect(mockGenerateRetreatZip).toHaveBeenCalledWith("new-request-id", 42, 1);
  });

  it("should reuse an in-flight request instead of starting a second ZIP", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUser());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce({ id: "in-flight", status: "processing" });

    const { status, body } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ request_id: "in-flight" });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });

  it("should return 404 when the event does not exist", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(404);
  });

  it("should return 401 when the token's user no longer exists", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(401);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("should return 403 when a user without a subscription requests a subscribers-only event", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(
      makeEvent({ audience: { slug: "free-subscribers" } }),
    );
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUser({ subscriptionStatus: "none" }));

    const { status } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(403);
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });

  it("should return 404 (not 403) for an archived event, even for an admin", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent({ status: "archived" }));
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUser({ role: "admin" }));

    const { status } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader("admin"),
    });

    expect(status).toBe(404);
  });

  it("should still answer 200 when background generation rejects", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUser());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);
    mockGenerateRetreatZip.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { status } = await testJson("/api/events/42/request-download", {
      method: "POST",
      headers: await authHeader(),
    });

    expect(status).toBe(200);
    consoleError.mockRestore();
  });
});

describe("POST /api/events/public/:id/request-download", () => {
  it("should create an anonymous request (no userId) for a public event", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);

    const { status, body } = await testJson("/api/events/public/42/request-download", {
      method: "POST",
    });

    expect(status).toBe(200);
    expect(body).toEqual({ request_id: "new-request-id" });
    expect(insertedValues).toEqual([{ eventId: 42, status: "pending" }]);
    expect(mockGenerateRetreatZip).toHaveBeenCalledWith("new-request-id", 42);
  });

  it("should reuse an existing anonymous request that has not expired", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce({
      id: "shared-ready",
      status: "ready",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const { body } = await testJson("/api/events/public/42/request-download", { method: "POST" });

    expect(body).toEqual({ request_id: "shared-ready" });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });

  it("should start a new ZIP when the existing anonymous request has expired", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce({
      id: "stale",
      status: "ready",
      expiresAt: new Date(Date.now() - 1000),
    });

    const { body } = await testJson("/api/events/public/42/request-download", { method: "POST" });

    expect(body).toEqual({ request_id: "new-request-id" });
    expect(mockGenerateRetreatZip).toHaveBeenCalledTimes(1);
  });

  it("should return 404 when the event does not exist", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson("/api/events/public/42/request-download", { method: "POST" });

    expect(status).toBe(404);
  });

  it("should return 401 for an event whose audience is not public", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(
      makeEvent({ audience: { slug: "retreat-group-members" } }),
    );

    const { status } = await testJson("/api/events/public/42/request-download", { method: "POST" });

    expect(status).toBe(401);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("should return 404 for a draft event with a public audience", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent({ status: "draft" }));
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson("/api/events/public/42/request-download", { method: "POST" });

    expect(status).toBe(404);
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });
});
