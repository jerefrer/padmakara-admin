import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import { originalNameFromMasterKey } from "../../../src/lib/file-info.ts";

vi.mock("../../../src/db/index.ts", () => {
  const findFirstTrack = vi.fn(() => Promise.resolve(null));
  const findFirstVideo = vi.fn(() => Promise.resolve(null));
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const values = vi.fn(() => ({ returning }));
  return {
    db: {
      update: vi.fn(() => ({ set })),
      insert: vi.fn(() => ({ values })),
      query: {
        tracks: { findFirst: findFirstTrack },
        eventVideos: { findFirst: findFirstVideo },
        sessions: { findFirst: vi.fn(() => Promise.resolve(null)) },
      },
      _findFirstTrack: findFirstTrack,
      _findFirstVideo: findFirstVideo,
      _returning: returning,
    },
  };
});

vi.mock("../../../src/services/bunny.ts", () => ({
  getVideoMeta: vi.fn(),
  deleteVideo: vi.fn(),
  fetchVideo: vi.fn(),
}));

vi.mock("../../../src/services/audio-details.ts", () => ({
  recordTrackAudioDetails: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { getVideoMeta } from "../../../src/services/bunny.ts";
import { recordTrackAudioDetails } from "../../../src/services/audio-details.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const findTrack = (db as any)._findFirstTrack as ReturnType<typeof vi.fn>;
const findVideo = (db as any)._findFirstVideo as ReturnType<typeof vi.fn>;
const returning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockMeta = getVideoMeta as ReturnType<typeof vi.fn>;
const mockRecord = recordTrackAudioDetails as ReturnType<typeof vi.fn>;

async function auth() {
  const token = await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("originalNameFromMasterKey", () => {
  it("should strip the timestamp prefix and the folders", () => {
    expect(
      originalNameFromMasterKey("events/E1/masters/1793719588499-JKR-Lx-2026-10-10-AM.mp4"),
    ).toBe("JKR-Lx-2026-10-10-AM.mp4");
  });

  it("should keep a name that has no timestamp prefix", () => {
    expect(originalNameFromMasterKey("events/E1/masters/talk.mp4")).toBe("talk.mp4");
  });
});

describe("GET /api/admin/tracks/:id/file-info", () => {
  it("should return the stored file details", async () => {
    findTrack.mockResolvedValueOnce({
      id: 5,
      s3Key: "events/E/01.mp3",
      originalFilename: "talk original.mp3",
      fileSizeBytes: 12345678,
      fileFormat: "mp3",
      durationSeconds: 600,
      bitrateKbps: 128,
      sampleRateHz: 44100,
      channels: 2,
    });
    const { status, body } = await testJson("/api/admin/tracks/5/file-info", { headers: await auth() });
    expect(status).toBe(200);
    expect(body).toEqual({
      originalFilename: "talk original.mp3",
      sizeBytes: 12345678,
      format: "mp3",
      durationSeconds: 600,
      bitrateKbps: 128,
      sampleRateHz: 44100,
      channels: 2,
    });
  });

  it("should return nulls for unknown values and fall back to the s3 key extension", async () => {
    findTrack.mockResolvedValueOnce({
      id: 6,
      s3Key: "events/E/02.m4a",
      originalFilename: null,
      fileSizeBytes: null,
      fileFormat: null,
      durationSeconds: 0,
      bitrateKbps: null,
      sampleRateHz: null,
      channels: null,
    });
    const { body } = await testJson("/api/admin/tracks/6/file-info", { headers: await auth() });
    expect(body).toEqual({
      originalFilename: null,
      sizeBytes: null,
      format: "m4a",
      durationSeconds: null,
      bitrateKbps: null,
      sampleRateHz: null,
      channels: null,
    });
  });

  it("should return 404 for an unknown track", async () => {
    const { status } = await testJson("/api/admin/tracks/9/file-info", { headers: await auth() });
    expect(status).toBe(404);
  });

  it("should require authentication", async () => {
    const { status } = await testJson("/api/admin/tracks/5/file-info");
    expect(status).toBe(401);
  });
});

describe("GET /api/admin/videos/:id/file-info", () => {
  it("should combine the master file name with Bunny's resolution", async () => {
    findVideo.mockResolvedValueOnce({
      id: 3,
      masterS3Key: "events/E/masters/1793719588499-JKR-Lx.mp4",
      burnMasterBytes: 9_000_000_000,
      durationSeconds: 3600,
      bunnyVideoId: "guid-1",
    });
    mockMeta.mockResolvedValueOnce({ width: 1920, height: 1080, framerate: 25, length: 3601 });
    const { status, body } = await testJson("/api/admin/videos/3/file-info", { headers: await auth() });
    expect(status).toBe(200);
    expect(mockMeta).toHaveBeenCalledWith("guid-1");
    expect(body).toEqual({
      originalFilename: "JKR-Lx.mp4",
      sizeBytes: 9_000_000_000,
      durationSeconds: 3600,
      width: 1920,
      height: 1080,
      framerate: 25,
    });
  });

  it("should return nulls for an old video without master or Bunny id", async () => {
    findVideo.mockResolvedValueOnce({
      id: 4,
      masterS3Key: null,
      burnMasterBytes: null,
      durationSeconds: null,
      bunnyVideoId: null,
    });
    const { body } = await testJson("/api/admin/videos/4/file-info", { headers: await auth() });
    expect(mockMeta).not.toHaveBeenCalled();
    expect(body).toEqual({
      originalFilename: null,
      sizeBytes: null,
      durationSeconds: null,
      width: null,
      height: null,
      framerate: null,
    });
  });

  it("should return nulls for the resolution when Bunny fails", async () => {
    findVideo.mockResolvedValueOnce({
      id: 5,
      masterS3Key: null,
      burnMasterBytes: null,
      durationSeconds: 60,
      bunnyVideoId: "guid-2",
    });
    mockMeta.mockRejectedValueOnce(new Error("Bunny API 500"));
    const { status, body } = await testJson("/api/admin/videos/5/file-info", { headers: await auth() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ width: null, height: null, framerate: null, durationSeconds: 60 });
  });

  it("should return 404 for an unknown video", async () => {
    const { status } = await testJson("/api/admin/videos/9/file-info", { headers: await auth() });
    expect(status).toBe(404);
  });
});

describe("audio details capture on track save", () => {
  const payload = { sessionId: 1, title: "T", trackNumber: 1 };

  it("should record audio details after creating a track with an audio file", async () => {
    returning.mockResolvedValueOnce([{ id: 11, sessionId: 1, s3Key: "events/E/01.mp3" }]);
    const { status } = await testJson("/api/admin/tracks", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...payload, s3Key: "events/E/01.mp3" }),
    });
    expect(status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith(11, "events/E/01.mp3");
  });

  it("should not record anything for a track created without audio", async () => {
    returning.mockResolvedValueOnce([{ id: 12, sessionId: 1, s3Key: null }]);
    await testJson("/api/admin/tracks", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify(payload),
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("should record audio details when a PUT attaches a new s3Key", async () => {
    returning.mockResolvedValueOnce([{ id: 13, sessionId: 1, s3Key: "events/E/02.mp3" }]);
    const { status } = await testJson("/api/admin/tracks/13", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ s3Key: "events/E/02.mp3" }),
    });
    expect(status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(13, "events/E/02.mp3");
  });

  it("should not touch audio details when a PUT does not change the file", async () => {
    returning.mockResolvedValueOnce([{ id: 14, sessionId: 1, s3Key: "events/E/03.mp3" }]);
    await testJson("/api/admin/tracks/14", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("should not fail the save when recording audio details rejects", async () => {
    mockRecord.mockRejectedValueOnce(new Error("boom"));
    returning.mockResolvedValueOnce([{ id: 15, sessionId: 1, s3Key: "events/E/04.mp3" }]);
    const { status } = await testJson("/api/admin/tracks", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...payload, s3Key: "events/E/04.mp3" }),
    });
    expect(status).toBe(201);
  });
});
