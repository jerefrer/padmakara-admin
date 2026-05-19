import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories run hoisted — the mock object can't reference outer state,
// so we expose vi.fn() handles via a shared module accessor.
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      tracks: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
      transcripts: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
    },
    select: vi.fn(),
  },
}));

vi.mock("../../src/services/bunny.ts", async (orig) => {
  const actual = await orig<typeof import("../../src/services/bunny.ts")>();
  return {
    ...actual,
    getVideoMeta: vi.fn(),
  };
});

import { db } from "../../src/db/index.ts";
import { testJson } from "../helpers.ts";
import { getVideoMeta } from "../../src/services/bunny.ts";

const mockDb = db as any;
const mockGetVideoMeta = getVideoMeta as ReturnType<typeof vi.fn>;

const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";

function makeSessionWithVideo(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    eventId: 1,
    titleEn: "Day 1 Morning",
    sessionNumber: 1,
    bunnyVideoId: VIDEO_GUID,
    videoDurationSeconds: 1800,
    videoPosterUrl: null,
    event: {
      id: 1,
      status: "published",
      audience: { slug: "free-anyone" },
      audienceId: 1,
    },
    ...overrides,
  };
}

describe("GET /api/media/video/session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns signed playback URLs for a session with a video on a public event", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());

    const { status, body } = await testJson(`/api/media/video/session/7`);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      hls: expect.stringContaining(`/${VIDEO_GUID}/playlist.m3u8`),
      iframe: expect.stringContaining(VIDEO_GUID),
      thumbnail: expect.stringContaining(`/${VIDEO_GUID}/thumbnail.jpg`),
      durationSeconds: 1800,
      expiresAt: expect.any(Number),
    });
    expect(body.hls).toMatch(/[?&]token=/);
    expect(body.hls).toMatch(/[?&]expires=\d+/);
  });

  it("uses the cached videoPosterUrl as thumbnail when present", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(
      makeSessionWithVideo({ videoPosterUrl: "https://cdn.example/custom-poster.jpg" }),
    );

    const { status, body } = await testJson(`/api/media/video/session/7`);

    expect(status).toBe(200);
    expect(body.thumbnail).toBe("https://cdn.example/custom-poster.jpg");
  });

  it("returns 404 when the session does not exist", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(null);

    const { status } = await testJson(`/api/media/video/session/9999`);
    expect(status).toBe(404);
  });

  it("returns 404 when the session has no video attached", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(
      makeSessionWithVideo({ bunnyVideoId: null }),
    );

    const { status } = await testJson(`/api/media/video/session/7`);
    expect(status).toBe(404);
  });

  it("returns 401 when accessing a session on a non-public event without auth", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(
      makeSessionWithVideo({
        event: { id: 1, status: "published", audience: { slug: "free-subscribers" }, audienceId: 2 },
      }),
    );

    const { status } = await testJson(`/api/media/video/session/7`);
    expect(status).toBe(401);
  });
});

describe("GET /api/media/video/session/:sessionId/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockMeta(availableResolutions: string | null = "240p,360p,480p,720p,1080p") {
    mockGetVideoMeta.mockResolvedValueOnce({
      guid: VIDEO_GUID,
      title: "T",
      status: 4,
      length: 1234,
      width: 1920,
      height: 1080,
      framerate: 30,
      thumbnailFileName: "thumbnail.jpg",
      availableResolutions,
    });
  }

  it("returns a token-signed MP4 URL at the requested quality when available", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());
    mockMeta();

    const { status, body } = await testJson(`/api/media/video/session/7/download?quality=480p`);

    expect(status).toBe(200);
    expect(body.quality).toBe("480p");
    expect(body.requestedQuality).toBe("480p");
    expect(body.url).toContain(`/${VIDEO_GUID}/play_480p.mp4`);
    expect(body.url).toMatch(/[?&]token=/);
  });

  it("defaults to 720p when quality is omitted", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());
    mockMeta();

    const { status, body } = await testJson(`/api/media/video/session/7/download`);
    expect(status).toBe(200);
    expect(body.quality).toBe("720p");
    expect(body.url).toContain("play_720p.mp4");
  });

  it("falls back to the highest available variant when source is below requested", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());
    mockMeta("240p,360p,480p");

    const { status, body } = await testJson(`/api/media/video/session/7/download?quality=720p`);

    expect(status).toBe(200);
    expect(body.quality).toBe("480p");
    expect(body.requestedQuality).toBe("720p");
    expect(body.availableResolutions).toEqual(["240p", "360p", "480p"]);
  });

  it("never upgrades quality above what was requested", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());
    mockMeta();

    const { status, body } = await testJson(`/api/media/video/session/7/download?quality=480p`);
    expect(status).toBe(200);
    expect(body.quality).toBe("480p");
  });

  it("returns 404 when no MP4 variants exist", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(makeSessionWithVideo());
    mockMeta(null);

    const { status } = await testJson(`/api/media/video/session/7/download?quality=720p`);
    expect(status).toBe(404);
  });

  it("rejects unknown quality with 400", async () => {
    const { status } = await testJson(`/api/media/video/session/7/download?quality=4k`);
    expect(status).toBe(400);
    expect(mockDb.query.sessions.findFirst).not.toHaveBeenCalled();
    expect(mockGetVideoMeta).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no video", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(
      makeSessionWithVideo({ bunnyVideoId: null }),
    );

    const { status } = await testJson(`/api/media/video/session/7/download`);
    expect(status).toBe(404);
    expect(mockGetVideoMeta).not.toHaveBeenCalled();
  });

  it("returns 401 for non-public events without auth", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce(
      makeSessionWithVideo({
        event: { id: 1, status: "published", audience: { slug: "free-subscribers" }, audienceId: 2 },
      }),
    );

    const { status } = await testJson(`/api/media/video/session/7/download`);
    expect(status).toBe(401);
    expect(mockGetVideoMeta).not.toHaveBeenCalled();
  });
});
