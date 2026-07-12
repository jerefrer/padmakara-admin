import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockFindFirstSessionVideo = vi.fn(() => Promise.resolve(null));
  const mockFindFirstSession = vi.fn(() => Promise.resolve(null));
  const mockFindManySessionVideo = vi.fn(() => Promise.resolve([]));
  return {
    db: {
      delete: mockDelete,
      update: mockUpdate,
      insert: mockInsert,
      query: {
        sessionVideos: { findFirst: mockFindFirstSessionVideo, findMany: mockFindManySessionVideo },
        sessions: { findFirst: mockFindFirstSession },
      },
      _delete: mockDelete,
      _update: mockUpdate,
      _insert: mockInsert,
      _where: mockWhere,
      _returning: mockReturning,
      _findFirstSessionVideo: mockFindFirstSessionVideo,
      _findFirstSession: mockFindFirstSession,
    },
  };
});

vi.mock("../../../src/services/bunny.ts", () => ({
  deleteVideo: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { deleteVideo } from "../../../src/services/bunny.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockFindFirstSessionVideo = (db as any)._findFirstSessionVideo as ReturnType<typeof vi.fn>;
const mockFindFirstSession = (db as any)._findFirstSession as ReturnType<typeof vi.fn>;
const mockDeleteVideo = deleteVideo as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("DELETE /api/admin/session-videos/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSession.mockResolvedValue({ id: 7, eventId: 1 });
  });

  it("deletes the row and the Bunny video when no other row references the GUID", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 3, sessionId: 7, bunnyVideoId: "guid-a", position: 0 },
    ]);
    mockFindFirstSessionVideo.mockResolvedValueOnce(null); // no other row shares the GUID

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/3", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 3, bunnyVideoId: "guid-a" });
    expect(mockDeleteVideo).toHaveBeenCalledWith("guid-a");
  });

  it("skips Bunny cleanup when another row still references the GUID", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 4, sessionId: 7, bunnyVideoId: "guid-shared", position: 1 },
    ]);
    mockFindFirstSessionVideo.mockResolvedValueOnce({ id: 5, sessionId: 8, bunnyVideoId: "guid-shared" });

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/4", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(mockDeleteVideo).not.toHaveBeenCalled();
  });

  it("returns 404 when the session_video does not exist", async () => {
    mockReturning.mockResolvedValueOnce([]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/999", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(mockDeleteVideo).not.toHaveBeenCalled();
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/session-videos/3", {
      method: "DELETE",
    });
    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/session-videos/3", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/session-videos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSession.mockResolvedValue({ id: 7, eventId: 1 });
  });

  it("creates a session_video row", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 10, sessionId: 7, bunnyVideoId: "new-guid", position: 0, title: null },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, bunnyVideoId: "new-guid" }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 10, sessionId: 7, bunnyVideoId: "new-guid" });
  });

  it("returns 400 for an invalid payload", async () => {
    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7 }), // missing bunnyVideoId
    });
    expect(status).toBe(400);
  });
});

describe("PATCH /api/admin/session-videos/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSession.mockResolvedValue({ id: 7, eventId: 1 });
  });

  it("updates position and title", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 3, sessionId: 7, bunnyVideoId: "guid-a", position: 1, title: "Part 2" },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/3", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ position: 1, title: "Part 2" }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 3, position: 1, title: "Part 2" });
  });

  it("returns 404 when the row does not exist", async () => {
    mockReturning.mockResolvedValueOnce([]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/999", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ position: 1 }),
    });
    expect(status).toBe(404);
  });
});
