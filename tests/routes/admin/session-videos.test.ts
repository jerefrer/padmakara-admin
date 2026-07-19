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
      _values: mockValues,
      _where: mockWhere,
      _returning: mockReturning,
      _findFirstSessionVideo: mockFindFirstSessionVideo,
      _findFirstSession: mockFindFirstSession,
      _findManySessionVideo: mockFindManySessionVideo,
    },
  };
});

vi.mock("../../../src/services/bunny.ts", () => ({
  deleteVideo: vi.fn(() => Promise.resolve()),
  fetchVideo: vi.fn(() => Promise.resolve({ guid: "fetched-guid" })),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/subtitles.ts", () => ({
  submitSubtitleJob: vi.fn(() =>
    Promise.resolve({
      jobId: "job-1",
      batchJobId: "batch-1",
      status: "submitted",
      sessionId: 7,
      sessionVideoId: 3,
      language: "en",
      trackCount: 2,
    }),
  ),
  getSubtitleJobsForVideo: vi.fn(() => Promise.resolve([])),
  getVideoSubtitles: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/services/subtitle-translate.ts", () => ({
  translateSubtitles: vi.fn(() => Promise.resolve({ s3Key: "events/E/subtitles/s1/v3/pt.vtt", jobId: "job-2" })),
}));

vi.mock("../../../src/services/bunny-captions.ts", () => ({
  addCaption: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/s3.ts", () => ({
  getObjectText: vi.fn(() => Promise.resolve("")),
  putObject: vi.fn(() => Promise.resolve()),
  generatePresignedDownloadUrl: vi.fn(() =>
    Promise.resolve("https://presigned.example/signed-url"),
  ),
}));

import { db } from "../../../src/db/index.ts";
import { deleteVideo, fetchVideo } from "../../../src/services/bunny.ts";
import { generatePresignedDownloadUrl } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";
import { submitSubtitleJob } from "../../../src/services/subtitles.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockValues = (db as any)._values as ReturnType<typeof vi.fn>;
const mockFindFirstSessionVideo = (db as any)._findFirstSessionVideo as ReturnType<typeof vi.fn>;
const mockFindFirstSession = (db as any)._findFirstSession as ReturnType<typeof vi.fn>;
const mockFindManySessionVideo = (db as any)._findManySessionVideo as ReturnType<typeof vi.fn>;
const mockDeleteVideo = deleteVideo as ReturnType<typeof vi.fn>;
const mockFetchVideo = fetchVideo as ReturnType<typeof vi.fn>;
const mockPresign = generatePresignedDownloadUrl as ReturnType<typeof vi.fn>;

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

describe("POST /api/admin/session-videos/import-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSession.mockResolvedValue({ id: 7, eventId: 1 });
    mockFindManySessionVideo.mockResolvedValue([]);
    mockFetchVideo.mockResolvedValue({ guid: "fetched-guid" });
  });

  it("imports from a generic public URL, deriving the title from the filename", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 20, sessionId: 7, bunnyVideoId: "fetched-guid", position: 0, title: "dharma talk" },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "https://example.com/videos/dharma%20talk.mp4" }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 20, bunnyVideoId: "fetched-guid" });
    expect(mockFetchVideo).toHaveBeenCalledWith(
      "https://example.com/videos/dharma%20talk.mp4",
      "dharma talk",
    );
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        bunnyVideoId: "fetched-guid",
        position: 0,
        title: "dharma talk",
      }),
    );
  });

  it("appends after existing videos (next position)", async () => {
    mockFindManySessionVideo.mockResolvedValue([{ position: 0 }, { position: 1 }]);
    mockReturning.mockResolvedValueOnce([
      { id: 21, sessionId: 7, bunnyVideoId: "fetched-guid", position: 2, title: null },
    ]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "https://example.com/v.mp4" }),
    });

    expect(status).toBe(201);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ position: 2 }));
  });

  it("normalizes a Google Drive share link before handing it to Bunny", async () => {
    const driveId = "1AbC-dEf_9xYz1234567890abcdefghijklm";
    mockReturning.mockResolvedValueOnce([
      { id: 22, sessionId: 7, bunnyVideoId: "fetched-guid", position: 0, title: null },
    ]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: 7,
        url: `https://drive.google.com/file/d/${driveId}/view?usp=sharing`,
      }),
    });

    expect(status).toBe(201);
    expect(mockFetchVideo).toHaveBeenCalledWith(
      `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`,
      "Imported video",
    );
    // No filename available from a Drive share link → row title stays null
    // so the admin panel derives "Part N".
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ title: null }));
  });

  it("uses the provided title when given", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 23, sessionId: 7, bunnyVideoId: "fetched-guid", position: 0, title: "Part 3" },
    ]);

    const token = await adminToken();
    await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "https://example.com/v.mp4", title: "Part 3" }),
    });

    expect(mockFetchVideo).toHaveBeenCalledWith("https://example.com/v.mp4", "Part 3");
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ title: "Part 3" }));
  });

  it("presigns URLs that point at the app's own private S3 bucket", async () => {
    mockPresign.mockResolvedValue("https://presigned.example/signed-url");
    mockReturning.mockResolvedValueOnce([
      { id: 24, sessionId: 7, bunnyVideoId: "fetched-guid", position: 0, title: "video" },
    ]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: 7,
        url: "https://padmakara-pt-app.s3.eu-west-3.amazonaws.com/Videos_for_app_testing/2025-04-JKR-CCA/2025-04-14-JKR-Mind_Training-Morning-CCA.mp4",
      }),
    });

    expect(status).toBe(201);
    expect(mockPresign).toHaveBeenCalledWith(
      "Videos_for_app_testing/2025-04-JKR-CCA/2025-04-14-JKR-Mind_Training-Morning-CCA.mp4",
      12 * 3600,
    );
    expect(mockFetchVideo).toHaveBeenCalledWith(
      "https://presigned.example/signed-url",
      "2025-04-14-JKR-Mind_Training-Morning-CCA",
    );
  });

  it("returns 502 with a clear message when Bunny cannot fetch the URL", async () => {
    mockFetchVideo.mockRejectedValueOnce(
      new Error('Bunny fetch 403: {"success":false,"message":"Origin returned HTTP 403 (Forbidden)."}'),
    );

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "https://example.com/private.mp4" }),
    });

    expect(status).toBe(502);
    expect(body.code).toBe("BUNNY_FETCH_FAILED");
    expect(body.error).toMatch(/publicly downloadable/i);
  });

  it("returns 400 for an invalid URL", async () => {
    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "not a url" }),
    });
    expect(status).toBe(400);
    expect(mockFetchVideo).not.toHaveBeenCalled();
  });

  it("returns 400 for a Drive folder link", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: 7,
        url: "https://drive.google.com/drive/folders/1AbC-dEf_9xYz1234567890abcdefghijklm",
      }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("DRIVE_FOLDER_LINK");
  });

  it("returns 404 when the session does not exist", async () => {
    mockFindFirstSession.mockResolvedValue(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 99, url: "https://example.com/v.mp4" }),
    });
    expect(status).toBe(404);
    expect(mockFetchVideo).not.toHaveBeenCalled();
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/session-videos/import-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: 7, url: "https://example.com/v.mp4" }),
    });
    expect(status).toBe(401);
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

describe("POST /api/admin/session-videos/:videoId/subtitles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls submitSubtitleJob with the session_video id", async () => {
    const mockSubmit = submitSubtitleJob as ReturnType<typeof vi.fn>;

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/session-videos/3/subtitles", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ language: "en", whisperModel: "turbo" }),
    });

    expect(status).toBe(202);
    expect(mockSubmit).toHaveBeenCalledWith(3, { language: "en", whisperModel: "turbo" });
    expect(body).toMatchObject({ jobId: "job-1", sessionVideoId: 3 });
  });
});
