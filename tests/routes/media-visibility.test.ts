import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// An event can be published with only its audio or only its video showing. These
// tests pin the server-side half: hidden media is never returned to a regular
// user and is a 404 when asked for directly; admins keep seeing everything.

const { mockDb, mockGenerateRetreatZip } = vi.hoisted(() => {
  const mockDb = {
    query: {
      events: { findFirst: vi.fn(), findMany: vi.fn() },
      audiences: { findFirst: vi.fn() },
      downloadRequests: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
      tracks: { findFirst: vi.fn() },
      eventVideos: { findFirst: vi.fn() },
      userProgress: { findFirst: vi.fn(), findMany: vi.fn() },
      trackBookmarks: { findMany: vi.fn(), findFirst: vi.fn() },
      videoBookmarks: { findMany: vi.fn() },
      retreatGroups: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() =>
        Object.assign(Promise.resolve<unknown[]>([]), {
          where: vi.fn(() => Promise.resolve([])),
        }),
      ),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "req-1" }])),
      })),
    })),
  };
  const mockGenerateRetreatZip = vi.fn(() => Promise.resolve());
  return { mockDb, mockGenerateRetreatZip };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/zip-generator.ts", () => ({
  generateRetreatZip: mockGenerateRetreatZip,
}));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
}));
vi.mock("../../src/services/publication-access.ts", () => ({
  openablePublications: vi.fn(() => Promise.resolve(new Set<number>())),
}));

import { createAccessToken } from "../../src/services/auth.ts";

const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "published",
    audience: { slug: "free-anyone" },
    audienceId: 1,
    audioPublished: true,
    videoPublished: true,
    eventTeachers: [],
    eventRetreatGroups: [],
    eventPlaces: [],
    eventPublications: [],
    eventOrganizers: [],
    transcripts: [{ id: 9 }],
    sessions: [
      { id: 10, tracks: [{ id: 100, title: "Intro", duration: 60 }] },
    ],
    videos: [{ id: 3, bunnyVideoId: VIDEO_GUID, posterUrl: null }],
    ...overrides,
  };
}

async function auth(role: string) {
  const token = await createAccessToken({ sub: 1, email: "t@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

function userRow(role: string) {
  return {
    id: 1,
    email: "t@test.com",
    role,
    subscriptionStatus: "active",
    subscriptionExpiresAt: null,
  };
}

const AUDIO_HIDDEN = { audioPublished: false };
const VIDEO_HIDDEN = { videoPublished: false };

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.select.mockImplementation(() => ({
    from: vi.fn(() =>
      Object.assign(Promise.resolve<unknown[]>([]), {
        where: vi.fn(() => Promise.resolve([])),
      }),
    ),
  }));
  mockDb.insert.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: "req-1" }])),
    })),
  }));
  mockGenerateRetreatZip.mockImplementation(() => Promise.resolve());
});

describe("GET /api/events/:id — hidden media", () => {
  it("should return the event without sessions when audio is hidden for a regular user", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { status, body } = await testJson("/api/events/1", { headers: await auth("user") });

    expect(status).toBe(200);
    expect(body.sessions).toEqual([]);
    expect(body.videos).toHaveLength(1);
    expect(body.transcripts).toHaveLength(1);
  });

  it("should return the event without videos when video is hidden for a regular user", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(VIDEO_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/1", { headers: await auth("user") });

    expect(body.videos).toEqual([]);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].tracks).toHaveLength(1);
  });

  it("should still return everything to an admin when both media are hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(
      makeEvent({ ...AUDIO_HIDDEN, ...VIDEO_HIDDEN }),
    );
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/1", { headers: await auth("admin") });

    expect(body.sessions).toHaveLength(1);
    expect(body.videos).toHaveLength(1);
  });
});

describe("event lists — hidden media", () => {
  it("should strip hidden media from GET /api/events for a regular user", async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));
    mockDb.query.events.findMany.mockResolvedValueOnce([
      makeEvent({ ...AUDIO_HIDDEN, ...VIDEO_HIDDEN }),
    ]);

    const { body } = await testJson("/api/events", { headers: await auth("user") });

    expect(body[0].sessions).toEqual([]);
    expect(body[0].videos).toEqual([]);
  });

  it("should keep hidden media in GET /api/events for an admin", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(AUDIO_HIDDEN)]);

    const { body } = await testJson("/api/events", { headers: await auth("admin") });

    expect(body[0].sessions).toHaveLength(1);
  });

  it("should strip hidden media from GET /api/events/public without a token", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 1, slug: "free-anyone" });
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(AUDIO_HIDDEN)]);

    const { body } = await testJson("/api/events/public");

    expect(body[0].sessions).toEqual([]);
    expect(body[0].videos).toHaveLength(1);
  });

  it("should strip hidden media from GET /api/events/public/:id without a token", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(VIDEO_HIDDEN));

    const { body } = await testJson("/api/events/public/1");

    expect(body.videos).toEqual([]);
    expect(body.sessions).toHaveLength(1);
  });

  it("should strip hidden media from GET /api/events/featured without a token", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));

    const { body } = await testJson("/api/events/featured");

    expect(body.sessions).toEqual([]);
  });

  it("should strip hidden media from GET /api/groups/:id/events for a regular user", async () => {
    mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce({ id: 5 });
    mockDb.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([{ eventId: 1 }])) })),
    }));
    mockDb.query.events.findMany.mockResolvedValueOnce([
      makeEvent({ ...AUDIO_HIDDEN, ...VIDEO_HIDDEN }),
    ]);
    mockDb.query.users.findFirst.mockResolvedValue(userRow("user"));

    const { status, body } = await testJson("/api/groups/5/events", {
      headers: await auth("user"),
    });

    expect(status).toBe(200);
    expect(body[0].sessions).toEqual([]);
    expect(body[0].videos).toEqual([]);
  });
});

describe("direct track and session lookups — hidden audio", () => {
  it("should return 404 for GET /api/events/tracks/:id when audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      session: { id: 10, event: makeEvent(AUDIO_HIDDEN) },
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { status } = await testJson("/api/events/tracks/100", { headers: await auth("user") });

    expect(status).toBe(404);
  });

  it("should return 404 for GET /api/events/sessions/:id when audio is hidden", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce({
      id: 10,
      tracks: [{ id: 100 }],
      event: makeEvent(AUDIO_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { status } = await testJson("/api/events/sessions/10", { headers: await auth("user") });

    expect(status).toBe(404);
  });

  it("should return the track to an admin when audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      session: { id: 10, event: makeEvent(AUDIO_HIDDEN) },
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { status } = await testJson("/api/events/tracks/100", { headers: await auth("admin") });

    expect(status).toBe(200);
  });
});

describe("media playback — hidden media", () => {
  const trackRow = (event: unknown) => ({
    id: 100,
    s3Key: "events/x/track.mp3",
    readAlongS3Key: "events/x/track.json",
    session: { id: 10, event },
  });
  const videoRow = (event: unknown) => ({
    id: 3,
    eventId: 1,
    bunnyVideoId: VIDEO_GUID,
    durationSeconds: 60,
    posterUrl: null,
    event,
  });

  it("should return 404 for the audio presigned URL when audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(AUDIO_HIDDEN)));

    const { status } = await testJson("/api/media/audio/100");

    expect(status).toBe(404);
  });

  it("should return the audio presigned URL when only video is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(VIDEO_HIDDEN)));

    const { status } = await testJson("/api/media/audio/100");

    expect(status).toBe(200);
  });

  it("should return the audio presigned URL to an admin when audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(AUDIO_HIDDEN)));
    mockDb.query.users.findFirst.mockResolvedValue(userRow("admin"));

    const { status } = await testJson("/api/media/audio/100", { headers: await auth("admin") });

    expect(status).toBe(200);
  });

  it("should return 404 for the read-along file when audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(AUDIO_HIDDEN)));

    const { status } = await testJson("/api/media/readalong/100");

    expect(status).toBe(404);
  });

  it("should return 404 for the video playback URL when video is hidden", async () => {
    mockDb.query.eventVideos.findFirst.mockResolvedValueOnce(videoRow(makeEvent(VIDEO_HIDDEN)));

    const { status } = await testJson("/api/media/video/3");

    expect(status).toBe(404);
  });

  it("should return 404 for the video MP4 download when video is hidden", async () => {
    mockDb.query.eventVideos.findFirst.mockResolvedValueOnce(videoRow(makeEvent(VIDEO_HIDDEN)));

    const { status } = await testJson("/api/media/video/3/download");

    expect(status).toBe(404);
  });

  it("should return the video playback URL when only audio is hidden", async () => {
    mockDb.query.eventVideos.findFirst.mockResolvedValueOnce(videoRow(makeEvent(AUDIO_HIDDEN)));

    const { status } = await testJson("/api/media/video/3");

    expect(status).toBe(200);
  });

  it("should return the video playback URL to an admin when video is hidden", async () => {
    mockDb.query.eventVideos.findFirst.mockResolvedValueOnce(videoRow(makeEvent(VIDEO_HIDDEN)));
    mockDb.query.users.findFirst.mockResolvedValue(userRow("admin"));

    const { status } = await testJson("/api/media/video/3", { headers: await auth("admin") });

    expect(status).toBe(200);
  });
});

describe("ZIP download — hidden audio", () => {
  it("should refuse a signed-in request and build nothing when audio is hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { status } = await testJson("/api/events/1/request-download", {
      method: "POST",
      headers: await auth("user"),
    });

    expect(status).toBe(404);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });

  it("should refuse an anonymous request and build nothing when audio is hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));

    const { status } = await testJson("/api/events/public/1/request-download", {
      method: "POST",
    });

    expect(status).toBe(404);
    expect(mockGenerateRetreatZip).not.toHaveBeenCalled();
  });

  it("should accept the request of an admin when audio is hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/events/1/request-download", {
      method: "POST",
      headers: await auth("admin"),
    });

    expect(status).toBe(200);
  });

  it("should accept the request when only video is hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(VIDEO_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/events/1/request-download", {
      method: "POST",
      headers: await auth("user"),
    });

    expect(status).toBe(200);
  });

  it("should refuse to hand out an already-built ZIP once audio is hidden", async () => {
    mockDb.query.downloadRequests.findFirst.mockResolvedValueOnce({
      id: "req-1",
      userId: 1,
      eventId: 1,
      status: "ready",
      s3Key: "zips/x.zip",
      expiresAt: null,
    });
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(AUDIO_HIDDEN));

    const { status } = await testJson("/api/download-requests/req-1/download", {
      headers: await auth("user"),
    });

    expect(status).toBe(404);
  });
});

describe("GET /api/search — hidden media", () => {
  it("should not match or list tracks of an event whose audio is hidden", async () => {
    const event = makeEvent({
      ...AUDIO_HIDDEN,
      titleEn: "Retreat",
      titlePt: null,
      mainThemesEn: null,
      mainThemesPt: null,
      sessionThemesEn: null,
      sessionThemesPt: null,
      sessions: [
        { id: 10, titleEn: "S", titlePt: null, sessionDate: null, timePeriod: null,
          sessionNumber: 1, tracks: [{ id: 100, title: "Bodhicitta talk" }] },
      ],
    });
    mockDb.query.events.findMany.mockResolvedValueOnce([event]);

    const { body } = await testJson("/api/search?q=bodhicitta");

    expect(body.totalResults).toBe(0);
  });

  it("should still match tracks for an admin when audio is hidden", async () => {
    const event = makeEvent({
      ...AUDIO_HIDDEN,
      titleEn: "Retreat",
      titlePt: null,
      mainThemesEn: null,
      mainThemesPt: null,
      sessionThemesEn: null,
      sessionThemesPt: null,
      sessions: [
        { id: 10, titleEn: "S", titlePt: null, sessionDate: null, timePeriod: null,
          sessionNumber: 1, tracks: [{ id: 100, title: "Bodhicitta talk" }] },
      ],
    });
    mockDb.query.events.findMany.mockResolvedValueOnce([event]);

    const { body } = await testJson("/api/search?q=bodhicitta", { headers: await auth("admin") });

    expect(body.totalResults).toBe(1);
  });
});

describe("content routes — hidden media", () => {
  it("should leave out track bookmarks of an event whose audio is hidden", async () => {
    mockDb.query.trackBookmarks.findMany.mockResolvedValueOnce([
      { id: 1, track: { id: 100, session: { id: 10, event: makeEvent(AUDIO_HIDDEN) } } },
      { id: 2, track: { id: 101, session: { id: 11, event: makeEvent() } } },
    ]);

    const { body } = await testJson("/api/content/track-bookmarks", {
      headers: await auth("user"),
    });

    expect(body.map((r: { id: number }) => r.id)).toEqual([2]);
  });

  it("should leave out video bookmarks of an event whose video is hidden", async () => {
    mockDb.query.videoBookmarks.findMany.mockResolvedValueOnce([
      { id: 1, video: { id: 3, event: makeEvent(VIDEO_HIDDEN) } },
      { id: 2, video: { id: 4, event: makeEvent() } },
    ]);

    const { body } = await testJson("/api/content/video-bookmarks", {
      headers: await auth("user"),
    });

    expect(body.map((r: { id: number }) => r.id)).toEqual([2]);
  });

  it("should not report a last-played track whose audio is hidden", async () => {
    mockDb.query.userProgress.findMany.mockResolvedValueOnce([
      {
        trackId: 100,
        positionSeconds: 5,
        isCompleted: false,
        lastPlayed: new Date(),
        track: { id: 100, session: { id: 10, event: makeEvent(AUDIO_HIDDEN) } },
      },
    ]);

    const { body } = await testJson("/api/content/last-played", { headers: await auth("user") });

    expect(body).toBeNull();
  });

  it("should reject progress on a track whose audio is hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      session: { id: 10, event: makeEvent(AUDIO_HIDDEN) },
    });

    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await auth("user"),
      body: JSON.stringify({ trackId: 100, positionSeconds: 5, durationSeconds: 60 }),
    });

    expect(status).toBe(404);
  });

  it("should reject video progress when video is hidden", async () => {
    mockDb.query.eventVideos.findFirst.mockResolvedValueOnce({
      id: 3,
      event: makeEvent(VIDEO_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValue(userRow("user"));

    const { status } = await testJson("/api/content/video-progress/3", {
      headers: await auth("user"),
    });

    expect(status).toBe(404);
  });
});
