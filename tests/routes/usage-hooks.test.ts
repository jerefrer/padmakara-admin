import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { testRequest } from "../helpers.ts";

// Each media route counts one usage event after access was granted: on
// success only, never on a denial or a missing record, and only for requests
// that start a file (no Range header, or a range from byte 0).

const m = vi.hoisted(() => ({
  transcript: vi.fn(),
  file: vi.fn(),
  track: vi.fn(),
  video: vi.fn(),
  access: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return {
    db: {
      query: {
        transcripts: { findFirst: (...a: any[]) => m.transcript(...a) },
        eventFiles: { findFirst: (...a: any[]) => m.file(...a) },
        tracks: { findFirst: (...a: any[]) => m.track(...a) },
        eventVideos: { findFirst: (...a: any[]) => m.video(...a) },
        users: { findFirst: vi.fn(() => Promise.resolve({ id: 1, role: "user", firstName: "A", lastName: "B" })) },
      },
      select: vi.fn(() => chain),
    },
  };
});

vi.mock("../../src/services/access.ts", () => ({
  checkEventAccess: (...a: any[]) => m.access(...a),
  denialToHttpError: () => {
    throw new AppErrorRef.AppError(403, "denied");
  },
  AUDIENCE_SLUGS: { PUBLIC: "free-anyone" },
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3/x")),
  getObjectText: vi.fn(() => Promise.resolve("{}")),
}));

vi.mock("../../src/services/bunny.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/bunny.ts")>();
  return {
    ...actual,
    getVideoMeta: vi.fn(() => Promise.resolve({ availableResolutions: "720p" })),
  };
});

import * as AppErrorRef from "../../src/lib/errors.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { issueMat } from "../../src/services/media-access.ts";
import { countUsage, countVideoStart } from "../../src/services/usage.ts";

const EVENT = { id: 3, status: "published", audience: { slug: "free-subscribers" } };

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "u@test.com", role: "user" })}`,
});

async function pdfBytes() {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  return new Uint8Array(await doc.save());
}

beforeEach(async () => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({ allowed: true });
  const bytes = await pdfBytes();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("transcript_open", () => {
  const row = { id: 9, s3Key: "k.pdf", originalFilename: "t.pdf", language: "en", event: EVENT };

  it("should count once with the event id when the transcript is served", async () => {
    m.transcript.mockResolvedValue(row);
    const res = await testRequest("/api/media/transcript/9", { headers: await auth() });
    expect(res.status).toBe(200);
    expect(countUsage).toHaveBeenCalledTimes(1);
    expect(countUsage).toHaveBeenCalledWith("transcript_open", 3);
  });

  it("should not count when access is denied", async () => {
    m.transcript.mockResolvedValue(row);
    m.access.mockResolvedValue({ allowed: false, reason: "NOT_MEMBER" });
    const res = await testRequest("/api/media/transcript/9", { headers: await auth() });
    expect(res.status).toBe(403);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count when the transcript does not exist", async () => {
    m.transcript.mockResolvedValue(null);
    const res = await testRequest("/api/media/transcript/9", { headers: await auth() });
    expect(res.status).toBe(404);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count a request for the middle of the file", async () => {
    m.transcript.mockResolvedValue(row);
    await testRequest("/api/media/transcript/9", { headers: { ...(await auth()), Range: "bytes=500-999" } });
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should count a range request that starts at zero", async () => {
    m.transcript.mockResolvedValue(row);
    await testRequest("/api/media/transcript/9", { headers: { ...(await auth()), Range: "bytes=0-99" } });
    expect(countUsage).toHaveBeenCalledWith("transcript_open", 3);
  });
});

describe("file_open", () => {
  const row = { id: 5, eventId: 3, extension: "png", sensitive: false, s3Key: "k", originalFilename: "p.png", event: EVENT };

  it("should count once with the event id when the file is served", async () => {
    m.file.mockResolvedValue(row);
    const res = await testRequest("/api/media/file/5", { headers: await auth() });
    expect(res.status).toBe(200);
    expect(countUsage).toHaveBeenCalledTimes(1);
    expect(countUsage).toHaveBeenCalledWith("file_open", 3);
  });

  it("should not count when access is denied", async () => {
    m.file.mockResolvedValue(row);
    m.access.mockResolvedValue({ allowed: false, reason: "NOT_MEMBER" });
    const res = await testRequest("/api/media/file/5", { headers: await auth() });
    expect(res.status).toBe(403);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count when the file does not exist", async () => {
    m.file.mockResolvedValue(null);
    const res = await testRequest("/api/media/file/5", { headers: await auth() });
    expect(res.status).toBe(404);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count a request for the middle of the file", async () => {
    m.file.mockResolvedValue(row);
    await testRequest("/api/media/file/5", { headers: { ...(await auth()), Range: "bytes=10-" } });
    expect(countUsage).not.toHaveBeenCalled();
  });
});

describe("readalong_open", () => {
  const row = { id: 10, readAlongS3Key: "ra.json", session: { event: EVENT } };

  it("should count once with the event id when the alignment is served", async () => {
    m.track.mockResolvedValue(row);
    const res = await testRequest("/api/media/readalong/10", { headers: await auth() });
    expect(res.status).toBe(200);
    expect(countUsage).toHaveBeenCalledTimes(1);
    expect(countUsage).toHaveBeenCalledWith("readalong_open", 3);
  });

  it("should not count when access is denied", async () => {
    m.track.mockResolvedValue(row);
    m.access.mockResolvedValue({ allowed: false, reason: "NOT_MEMBER" });
    const res = await testRequest("/api/media/readalong/10", { headers: await auth() });
    expect(res.status).toBe(403);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count when the track has no read-along data", async () => {
    m.track.mockResolvedValue({ ...row, readAlongS3Key: null });
    const res = await testRequest("/api/media/readalong/10", { headers: await auth() });
    expect(res.status).toBe(404);
    expect(countUsage).not.toHaveBeenCalled();
  });
});

describe("video_download", () => {
  const row = { id: 3, eventId: 3, bunnyVideoId: "guid", event: EVENT };

  it("should count with the event id when a download link is issued", async () => {
    m.video.mockResolvedValue(row);
    const res = await testRequest("/api/media/video/3/download", { headers: await auth() });
    expect(res.status).toBe(200);
    expect(countUsage).toHaveBeenCalledWith("video_download", 3);
  });

  it("should not count when access is denied", async () => {
    m.video.mockResolvedValue(row);
    m.access.mockResolvedValue({ allowed: false, reason: "NOT_MEMBER" });
    const res = await testRequest("/api/media/video/3/download", { headers: await auth() });
    expect(res.status).toBe(403);
    expect(countUsage).not.toHaveBeenCalled();
  });

  it("should not count when the video does not exist", async () => {
    m.video.mockResolvedValue(null);
    const res = await testRequest("/api/media/video/3/download", { headers: await auth() });
    expect(res.status).toBe(404);
    expect(countUsage).not.toHaveBeenCalled();
  });
});

describe("video_start", () => {
  it("should count the video when the HLS master playlist is served", async () => {
    const { token } = await issueMat({ userId: 1, videoId: 3, bunnyVideoId: "guid" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    const res = await testRequest(`/api/media/video/hls/3/master.m3u8?mat=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(countVideoStart).toHaveBeenCalledTimes(1);
    expect(countVideoStart).toHaveBeenCalledWith(3);
  });

  it("should not count when the token is missing", async () => {
    const res = await testRequest("/api/media/video/hls/3/master.m3u8");
    expect(res.status).toBe(401);
    expect(countVideoStart).not.toHaveBeenCalled();
  });

  it("should not count when the token belongs to another video", async () => {
    const { token } = await issueMat({ userId: 1, videoId: 4, bunnyVideoId: "guid" });
    const res = await testRequest(`/api/media/video/hls/3/master.m3u8?mat=${encodeURIComponent(token)}`);
    expect(res.status).toBe(403);
    expect(countVideoStart).not.toHaveBeenCalled();
  });
});
