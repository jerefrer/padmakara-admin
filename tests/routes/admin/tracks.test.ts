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
  return {
    db: {
      delete: mockDelete,
      update: mockUpdate,
      query: {
        sessions: { findFirst: mockFindFirst },
        tracks: { findFirst: mockFindFirst },
      },
      _delete: mockDelete,
      _update: mockUpdate,
      _where: mockWhere,
      _returning: mockReturning,
      _findFirst: mockFindFirst,
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
