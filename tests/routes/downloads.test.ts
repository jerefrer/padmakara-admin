import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// These tests drive the real routes mounted at /api/download-requests through
// the Hono app (optional auth, ownership checks, anonymous re-verification,
// expiry handling). Only the database and the storage presigner are mocked.

const { mockDb, updateSets, mockGeneratePresignedUrl } = vi.hoisted(() => {
  const updateSets: Array<Record<string, unknown>> = [];
  const mockDb = {
    query: {
      downloadRequests: { findFirst: vi.fn() },
      events: { findFirst: vi.fn() },
    },
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        updateSets.push(vals);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  const mockGeneratePresignedUrl = vi.fn((_key: string, _expiresIn?: number) =>
    Promise.resolve("https://storage.example.test/downloads/evt/zip.zip?sig=abc"),
  );
  return { mockDb, updateSets, mockGeneratePresignedUrl };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: mockGeneratePresignedUrl,
}));

import { createAccessToken } from "../../src/services/auth.ts";

const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";
const IN_A_DAY = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const A_SECOND_AGO = () => new Date(Date.now() - 1000);

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    userId: 1,
    eventId: 42,
    status: "processing",
    progressPercent: 45,
    totalFiles: 20,
    processedFiles: 9,
    errorMessage: null,
    s3Key: null,
    expiresAt: null,
    ...overrides,
  };
}

async function authHeader(userId = 1, role = "user") {
  const token = await createAccessToken({ sub: userId, email: `u${userId}@test.com`, role });
  return { Authorization: `Bearer ${token}` };
}

const publicEvent = { id: 42, status: "published", audience: { slug: "free-anyone" } };

beforeEach(() => {
  vi.clearAllMocks();
  updateSets.length = 0;
});

describe("GET /api/download-requests/:id/status", () => {
  it("should return progress for the owner of the request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest());

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      status: "processing",
      progress_percent: 45,
      total_files: 20,
      processed_files: 9,
    });
  });

  it("should return 404 when the request does not exist", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(404);
  });

  it("should return 403 when another user polls a request they do not own", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: 999 }));

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(403);
  });

  it("should return 403 when an anonymous caller polls a user-owned request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: 1 }));

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`);

    expect(status).toBe(403);
  });

  it("should treat an invalid token as anonymous and deny a user-owned request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: 1 }));

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    });

    expect(status).toBe(403);
  });

  it("should expose the error message of a failed request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ status: "failed", errorMessage: "No tracks found for this event" }),
    );

    const { body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(body.status).toBe("failed");
    expect(body.error_message).toBe("No tracks found for this event");
  });

  it("should flip a ready request past its expiry to expired and persist it", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ status: "ready", progressPercent: 100, expiresAt: A_SECOND_AGO() }),
    );

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(200);
    expect(body.status).toBe("expired");
    expect(body.error_message).toMatch(/expired/i);
    expect(updateSets).toEqual([expect.objectContaining({ status: "expired" })]);
  });

  it("should not write anything when a ready request is still within its expiry", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ status: "ready", progressPercent: 100, expiresAt: IN_A_DAY() }),
    );

    const { body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
      headers: await authHeader(1),
    });

    expect(body.status).toBe("ready");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  describe("anonymous requests (userId is null)", () => {
    it("should let anyone poll while the event is still public", async () => {
      mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: null }));
      mockDb.query.events.findFirst.mockResolvedValueOnce(publicEvent);

      const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`);

      expect(status).toBe(200);
      expect(body.status).toBe("processing");
    });

    it("should return 403 once the event audience is no longer public", async () => {
      mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: null }));
      mockDb.query.events.findFirst.mockResolvedValueOnce({
        ...publicEvent,
        audience: { slug: "retreat-group-members" },
      });

      const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/status`);

      expect(status).toBe(403);
      expect(body.error).toMatch(/no longer publicly available/);
    });

    it("should return 403 once the event has been unpublished", async () => {
      mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: null }));
      mockDb.query.events.findFirst.mockResolvedValueOnce({ ...publicEvent, status: "draft" });

      const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`);

      expect(status).toBe(403);
    });

    it("should return 403 when the event has been deleted", async () => {
      mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: null }));
      mockDb.query.events.findFirst.mockResolvedValueOnce(undefined);

      const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`);

      expect(status).toBe(403);
    });

    it("should re-verify the event even for an authenticated caller", async () => {
      mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ userId: null }));
      mockDb.query.events.findFirst.mockResolvedValueOnce({ ...publicEvent, status: "archived" });

      const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/status`, {
        headers: await authHeader(1),
      });

      expect(status).toBe(403);
    });
  });
});

describe("GET /api/download-requests/:id/download", () => {
  it("should return a fresh one-hour presigned URL for a ready request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({
        status: "ready",
        s3Key: "downloads/EVT/spring-retreat.zip",
        expiresAt: IN_A_DAY(),
      }),
    );

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      download_url: "https://storage.example.test/downloads/evt/zip.zip?sig=abc",
    });
    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith("downloads/EVT/spring-retreat.zip", 3600);
  });

  it("should return 400 NOT_READY while the ZIP is still being built", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ status: "processing" }));

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("NOT_READY");
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("should return 400 NOT_READY for a failed request", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(makeRequest({ status: "failed" }));

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/failed/);
  });

  it("should return 410 EXPIRED and persist the expired status past expiry", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ status: "ready", s3Key: "downloads/EVT/x.zip", expiresAt: A_SECOND_AGO() }),
    );

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(410);
    expect(body.code).toBe("EXPIRED");
    expect(updateSets).toEqual([expect.objectContaining({ status: "expired" })]);
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("should return 500 when a ready request has no storage key", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ status: "ready", s3Key: null, expiresAt: IN_A_DAY() }),
    );

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("should return 403 to a non-owner before revealing the request state", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ userId: 999, status: "ready", s3Key: "downloads/EVT/x.zip", expiresAt: IN_A_DAY() }),
    );

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/download`, {
      headers: await authHeader(1),
    });

    expect(status).toBe(403);
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("should return 404 when the request does not exist", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(undefined);

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/download`);

    expect(status).toBe(404);
  });

  it("should serve an anonymous request without a token while the event is public", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ userId: null, status: "ready", s3Key: "downloads/EVT/x.zip", expiresAt: IN_A_DAY() }),
    );
    mockDb.query.events.findFirst.mockResolvedValueOnce(publicEvent);

    const { status, body } = await testJson(`/api/download-requests/${REQUEST_ID}/download`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("should refuse an anonymous download once the event is no longer public", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(
      makeRequest({ userId: null, status: "ready", s3Key: "downloads/EVT/x.zip", expiresAt: IN_A_DAY() }),
    );
    mockDb.query.events.findFirst.mockResolvedValueOnce({
      ...publicEvent,
      audience: { slug: "free-subscribers" },
    });

    const { status } = await testJson(`/api/download-requests/${REQUEST_ID}/download`);

    expect(status).toBe(403);
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });
});
