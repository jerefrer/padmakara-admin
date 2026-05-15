import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// Mock S3 so the admin endpoints don't actually call AWS.
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedUploadUrl: vi.fn(),
  buildTrackS3Key: vi.fn((eventCode: string, _sessionNumber: number, filename: string) =>
    `events/${eventCode}/${filename}`,
  ),
  buildTranscriptS3Key: vi.fn((eventCode: string, filename: string) =>
    `events/${eventCode}/transcripts/${filename}`,
  ),
}));

// db is referenced indirectly via auth/admin middleware paths — mock minimally.
vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
    select: vi.fn(),
  },
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import { generatePresignedUploadUrl } from "../../../src/services/s3.ts";

const mockPresignUrl = generatePresignedUploadUrl as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

// ---------------------------------------------------------------------------
// presign-transcript
// ---------------------------------------------------------------------------

describe("POST /api/admin/upload/presign-transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid body and returns s3Key + uploadUrl", async () => {
    mockPresignUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "Session 1 Transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      s3Key: expect.stringContaining("transcripts/Session 1 Transcript.pdf"),
      uploadUrl: "https://s3.example.com/presigned-url",
    });
  });

  it("accepts filenames with accented characters, parentheses, and brackets", async () => {
    mockPresignUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "Réunion été (17 April AM) [TIB].pdf",
        contentType: "application/pdf",
      }),
    });

    // Should pass validation (S3 mock may or may not add more detail)
    expect(status).toBe(200);
  });

  it("rejects path traversal in filename (../)", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "../../etc/evil",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename with a forward slash", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "some/path/file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename with a backslash", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "some\\path\\file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename starting with a dot", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: ".hidden-file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects a body missing the filename field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects a body missing the eventCode field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects invalid (non-JSON) body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// infer-sessions
// ---------------------------------------------------------------------------

describe("POST /api/admin/upload/infer-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid array of track filenames and returns inferred sessions", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: [
          "001 JKR - The daily practice-(17 April AM).mp3",
          "002 JKR - The daily practice part 2-(17 April AM).mp3",
          "001 TRAD - A pratica diaria.mp3",
        ],
      }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalTracks: 3,
      originalTracks: expect.any(Number),
      translationTracks: expect.any(Number),
      sessions: expect.any(Array),
    });
  });

  it("rejects path traversal in a filename inside the array (../)", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: [
          "001 JKR - Good track.mp3",
          "../../etc/passwd",
        ],
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a filename with a forward slash inside the array", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: ["dir/subdir/track.mp3"],
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a body missing the filenames field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty filenames array", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filenames: [] }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid (non-JSON) body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      body: JSON.stringify({ filenames: ["001 JKR - track.mp3"] }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const { status } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filenames: ["001 JKR - track.mp3"] }),
    });

    expect(status).toBe(403);
  });
});
