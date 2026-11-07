import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockFindFirst = vi.fn(() => Promise.resolve(null));
  const mockFindMany = vi.fn(() => Promise.resolve([]));
  return {
    db: {
      delete: mockDelete,
      update: mockUpdate,
      query: {
        sessions: { findFirst: mockFindFirst },
        tracks: { findFirst: mockFindFirst, findMany: mockFindMany },
      },
      _delete: mockDelete,
      _update: mockUpdate,
      _where: mockWhere,
      _returning: mockReturning,
      _findFirst: mockFindFirst,
      _findMany: mockFindMany,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  deleteObject: vi.fn(() => Promise.resolve()),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://signed/")),
}));

import { db } from "../../../src/db/index.ts";
import { deleteObject } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("DELETE /api/admin/tracks/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the row and the audio + read-along S3 objects", async () => {
    mockReturning.mockResolvedValueOnce([
      {
        id: 42,
        title: "Track A",
        s3Key: "events/EVT/sessions/1/01.mp3",
        readAlongS3Key: "events/EVT/sessions/1/01.read-along.json",
      },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/tracks/42", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 42, title: "Track A" });
    expect(mockDeleteObject).toHaveBeenCalledWith(
      "events/EVT/sessions/1/01.mp3",
    );
    expect(mockDeleteObject).toHaveBeenCalledWith(
      "events/EVT/sessions/1/01.read-along.json",
    );
  });

  it("skips S3 cleanup when the track has no s3Key / readAlongS3Key", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 43, title: "Empty Track", s3Key: null, readAlongS3Key: null },
    ]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/tracks/43", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("returns 404 when the track does not exist", async () => {
    mockReturning.mockResolvedValueOnce([]); // delete returned nothing

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/tracks/999", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("still returns 200 if the S3 delete fails (best-effort cleanup)", async () => {
    mockReturning.mockResolvedValueOnce([
      {
        id: 44,
        title: "Track with stale S3 key",
        s3Key: "events/EVT/sessions/1/missing.mp3",
        readAlongS3Key: null,
      },
    ]);
    mockDeleteObject.mockRejectedValueOnce(new Error("NoSuchKey"));

    const token = await adminToken();
    const { status } = await testJson("/api/admin/tracks/44", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/tracks/42", {
      method: "DELETE",
    });
    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({
      sub: 2,
      email: "u@test.com",
      role: "user",
    });
    const { status } = await testJson("/api/admin/tracks/42", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
  });
});

describe("PUT /api/admin/tracks/:id", () => {
  const mockFindFirst = (db as any)._findFirst as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should say which track is in the way when the target session already uses its number", async () => {
    mockReturning.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "tracks_session_id_track_number_original_language_unique",
      }),
    );
    mockFindFirst
      .mockResolvedValueOnce({ id: 54953, sessionId: 1261, trackNumber: 93, originalLanguage: "pt" })
      .mockResolvedValueOnce({ id: 54951, title: "7 de Outubro - sessão da tarde - tradução integral" })
      .mockResolvedValueOnce({ id: 1260, sessionNumber: 4 });

    const { status, body } = await testJson("/api/admin/tracks/54953", {
      method: "PUT",
      headers: { Authorization: `Bearer ${await adminToken()}` },
      body: JSON.stringify({ sessionId: 1260 }),
    });

    expect(status).toBe(409);
    expect((body as any).error).toBe(
      'Session 4 already has a Portuguese track 93 ("7 de Outubro - sessão da tarde - tradução integral"). Give one of the two another number first.',
    );
  });

  it("should send what the admin needs to offer a fix: the track in the way and free numbers", async () => {
    mockReturning.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "tracks_session_id_track_number_original_language_unique",
      }),
    );
    mockFindFirst
      .mockResolvedValueOnce({ id: 54953, sessionId: 1261, trackNumber: 93, originalLanguage: "pt" })
      .mockResolvedValueOnce({ id: 54951, title: "7 de Outubro - sessão da tarde - tradução integral" })
      .mockResolvedValueOnce({ id: 1260, sessionNumber: 4 });
    // Portuguese numbers already used in the target session.
    ((db as any)._findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { trackNumber: 91 }, { trackNumber: 93 }, { trackNumber: 94 },
    ]);

    const { status, body } = await testJson("/api/admin/tracks/54953", {
      method: "PUT",
      headers: { Authorization: `Bearer ${await adminToken()}` },
      body: JSON.stringify({ sessionId: 1260 }),
    });

    expect(status).toBe(409);
    expect((body as any).code).toBe("TRACK_NUMBER_TAKEN");
    expect((body as any).details).toEqual({
      sessionNumber: 4,
      trackNumber: 93,
      language: "pt",
      blocking: { id: 54951, title: "7 de Outubro - sessão da tarde - tradução integral" },
      // 92 is free just below; above 93, 94 is taken, so 95.
      suggestedForBlocking: 92,
      suggestedForMoved: 95,
    });
  });
});
