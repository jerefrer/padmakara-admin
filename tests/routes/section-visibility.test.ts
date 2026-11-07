import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";
import { openablePublications } from "../../src/services/publication-access.ts";

// A published event can hide its transcripts (and read-along), its texts (files and
// related publications) or its topics (themes) while they are being edited. These tests
// pin the server-side half: the hidden section is never returned to a regular user and
// its items are a 404 when asked for directly; admins keep seeing everything.

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    query: {
      events: { findFirst: vi.fn(), findMany: vi.fn() },
      audiences: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
      tracks: { findFirst: vi.fn() },
      transcripts: { findFirst: vi.fn() },
      eventFiles: { findFirst: vi.fn() },
      userProgress: { findMany: vi.fn() },
      trackBookmarks: { findMany: vi.fn() },
      videoBookmarks: { findMany: vi.fn() },
      eventBookmarks: { findMany: vi.fn() },
      retreatGroups: { findFirst: vi.fn() },
    },
    select: vi.fn(),
  };
  return { mockDb };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
  getObjectText: vi.fn(() => Promise.resolve("{}")),
}));
vi.mock("../../src/services/publication-access.ts", () => ({
  openablePublications: vi.fn(() => Promise.resolve(new Set<number>())),
}));

import { createAccessToken } from "../../src/services/auth.ts";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "published",
    audience: { slug: "free-anyone" },
    audienceId: 1,
    audioPublished: true,
    videoPublished: true,
    transcriptsPublished: true,
    textsPublished: true,
    topicsPublished: true,
    titleEn: "Retreat",
    titlePt: null,
    mainThemesEn: "Compassion",
    mainThemesPt: "Compaixao",
    sessionThemesEn: "Bodhicitta",
    sessionThemesPt: "Bodicita",
    eventTeachers: [],
    eventRetreatGroups: [],
    eventPlaces: [],
    eventPublications: [
      { publication: { id: 3, title: "Pub", subtitle: null, coverImageS3Key: null } },
    ],
    eventOrganizers: [],
    transcripts: [{ id: 9 }],
    eventFiles: [{ id: 7 }],
    sessions: [
      {
        id: 10,
        titleEn: "S",
        titlePt: null,
        sessionDate: null,
        timePeriod: null,
        sessionNumber: 1,
        tracks: [{ id: 100, title: "Intro", duration: 60, readAlongS3Key: "k.json" }],
      },
    ],
    videos: [],
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

const TRANSCRIPTS_HIDDEN = { transcriptsPublished: false };
const TEXTS_HIDDEN = { textsPublished: false };
const TOPICS_HIDDEN = { topicsPublished: false };

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.select.mockImplementation(() => ({
    from: vi.fn(() =>
      Object.assign(Promise.resolve<unknown[]>([]), {
        where: vi.fn(() => Promise.resolve([])),
      }),
    ),
  }));
  vi.mocked(openablePublications).mockResolvedValue(new Set([3]));
});

describe("GET /api/events/:id", () => {
  it("should drop transcripts and read-along when transcripts are hidden for a user", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TRANSCRIPTS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/1", { headers: await auth("user") });

    expect(body.transcripts).toEqual([]);
    expect(body.sessions[0].tracks[0].hasReadAlong).toBe(false);
    expect(body.eventFiles).toHaveLength(1);
    expect(body.mainThemesEn).toBe("Compassion");
  });

  it("should offer transcripts and read-along to an admin when transcripts are hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TRANSCRIPTS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/1", { headers: await auth("admin") });

    expect(body.transcripts).toHaveLength(1);
    expect(body.sessions[0].tracks[0].hasReadAlong).toBe(true);
  });

  it("should drop files and related publications when texts are hidden for a user", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TEXTS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/1", { headers: await auth("user") });

    expect(body.eventFiles).toEqual([]);
    expect(body.relatedPublications).toEqual([]);
    expect(body.eventPublications).toEqual([]);
    expect(body.transcripts).toHaveLength(1);
  });

  it("should list files and related publications for an admin when texts are hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TEXTS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/1", { headers: await auth("admin") });

    expect(body.eventFiles).toHaveLength(1);
    expect(body.relatedPublications).toHaveLength(1);
  });

  it("should null the themes when topics are hidden for a user", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TOPICS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/1", { headers: await auth("user") });

    expect(body.mainThemesEn).toBeNull();
    expect(body.mainThemesPt).toBeNull();
    expect(body.sessionThemesEn).toBeNull();
    expect(body.sessionThemesPt).toBeNull();
    expect(body.sessions).toHaveLength(1);
  });

  it("should keep the themes for an admin when topics are hidden", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(TOPICS_HIDDEN));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/1", { headers: await auth("admin") });

    expect(body.mainThemesEn).toBe("Compassion");
    expect(body.sessionThemesPt).toBe("Bodicita");
  });
});

describe("event lists and public routes", () => {
  const hidden = { ...TRANSCRIPTS_HIDDEN, ...TEXTS_HIDDEN, ...TOPICS_HIDDEN };

  function expectStripped(event: Record<string, any>) {
    expect(event.transcripts).toEqual([]);
    expect(event.eventFiles).toEqual([]);
    expect(event.mainThemesEn).toBeNull();
    expect(event.sessionThemesEn).toBeNull();
  }

  it("should strip hidden sections from GET /api/events for a user", async () => {
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(hidden)]);

    const { body } = await testJson("/api/events", { headers: await auth("user") });

    expectStripped(body[0]);
  });

  it("should keep hidden sections in GET /api/events for an admin", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(hidden)]);

    const { body } = await testJson("/api/events", { headers: await auth("admin") });

    expect(body[0].transcripts).toHaveLength(1);
    expect(body[0].mainThemesEn).toBe("Compassion");
  });

  it("should strip hidden sections from GET /api/events/public", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 1, slug: "free-anyone" });
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(hidden)]);

    const { body } = await testJson("/api/events/public");

    expectStripped(body[0]);
  });

  it("should strip hidden sections from GET /api/events/public/:id", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(hidden));

    const { body } = await testJson("/api/events/public/1");

    expectStripped(body);
    expect(body.sessions[0].tracks[0].hasReadAlong).toBe(false);
  });

  it("should strip hidden sections from GET /api/events/featured", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent(hidden));

    const { body } = await testJson("/api/events/featured");

    expectStripped(body);
  });

  it("should strip hidden sections from GET /api/groups/:id/events", async () => {
    mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce({ id: 5 });
    mockDb.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([{ eventId: 1 }])) })),
    }));
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent(hidden)]);
    mockDb.query.users.findFirst.mockResolvedValue(userRow("user"));

    const { body } = await testJson("/api/groups/5/events", { headers: await auth("user") });

    expectStripped(body[0]);
  });
});

describe("direct track and session lookups", () => {
  it("should not offer read-along on GET /api/events/tracks/:id when transcripts are hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      readAlongS3Key: "k.json",
      session: { id: 10, event: makeEvent(TRANSCRIPTS_HIDDEN) },
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/tracks/100", { headers: await auth("user") });

    expect(body.hasReadAlong).toBe(false);
    expect(body.session.event.transcripts).toEqual([]);
  });

  it("should offer read-along on GET /api/events/tracks/:id to an admin", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      readAlongS3Key: "k.json",
      session: { id: 10, event: makeEvent(TRANSCRIPTS_HIDDEN) },
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/tracks/100", { headers: await auth("admin") });

    expect(body.hasReadAlong).toBe(true);
  });

  it("should not offer read-along nor themes on GET /api/events/sessions/:id when hidden", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce({
      id: 10,
      tracks: [{ id: 100, readAlongS3Key: "k.json" }],
      event: makeEvent({ ...TRANSCRIPTS_HIDDEN, ...TOPICS_HIDDEN }),
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user"));

    const { body } = await testJson("/api/events/sessions/10", { headers: await auth("user") });

    expect(body.tracks[0].hasReadAlong).toBe(false);
    expect(body.event.mainThemesEn).toBeNull();
  });
});

describe("media routes", () => {
  const FILE_ROW = {
    id: 7,
    s3Key: "events/x/file.txt",
    extension: "txt",
    originalFilename: "file.txt",
    sensitive: false,
  };
  const TRANSCRIPT_ROW = {
    id: 9,
    s3Key: "events/x/t.pdf",
    language: "en",
    originalFilename: "t.pdf",
  };
  const trackRow = (event: unknown) => ({
    id: 100,
    s3Key: "events/x/track.mp3",
    readAlongS3Key: "events/x/track.json",
    session: { id: 10, event },
  });

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("%PDF-1.4"))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return 404 for the transcript PDF when transcripts are hidden", async () => {
    mockDb.query.transcripts.findFirst.mockResolvedValueOnce({
      ...TRANSCRIPT_ROW,
      event: makeEvent(TRANSCRIPTS_HIDDEN),
    });

    const { status } = await testRequest("/api/media/transcript/9");

    expect(status).toBe(404);
  });

  it("should serve the transcript PDF when only texts are hidden", async () => {
    mockDb.query.transcripts.findFirst.mockResolvedValueOnce({
      ...TRANSCRIPT_ROW,
      event: makeEvent(TEXTS_HIDDEN),
    });

    const { status } = await testRequest("/api/media/transcript/9");

    expect(status).toBe(200);
  });

  it("should serve the transcript PDF to an admin when transcripts are hidden", async () => {
    mockDb.query.transcripts.findFirst.mockResolvedValueOnce({
      ...TRANSCRIPT_ROW,
      event: makeEvent(TRANSCRIPTS_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValue(userRow("admin"));

    const { status } = await testRequest("/api/media/transcript/9", { headers: await auth("admin") });

    expect(status).toBe(200);
  });

  it("should return 404 for the read-along file when transcripts are hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(TRANSCRIPTS_HIDDEN)));

    const { status } = await testJson("/api/media/readalong/100");

    expect(status).toBe(404);
  });

  it("should serve the read-along file to an admin when transcripts are hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(TRANSCRIPTS_HIDDEN)));
    mockDb.query.users.findFirst.mockResolvedValue(userRow("admin"));

    const { status } = await testJson("/api/media/readalong/100", { headers: await auth("admin") });

    expect(status).toBe(200);
  });

  it("should still play the audio when only transcripts are hidden", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce(trackRow(makeEvent(TRANSCRIPTS_HIDDEN)));

    const { status } = await testJson("/api/media/audio/100");

    expect(status).toBe(200);
  });

  it("should return 404 for an event file when texts are hidden", async () => {
    mockDb.query.eventFiles.findFirst.mockResolvedValueOnce({
      ...FILE_ROW,
      event: makeEvent(TEXTS_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValue(userRow("user"));

    const { status } = await testRequest("/api/media/file/7", { headers: await auth("user") });

    expect(status).toBe(404);
  });

  it("should serve an event file to an admin when texts are hidden", async () => {
    mockDb.query.eventFiles.findFirst.mockResolvedValueOnce({
      ...FILE_ROW,
      event: makeEvent(TEXTS_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValue(userRow("admin"));

    const { status } = await testRequest("/api/media/file/7", { headers: await auth("admin") });

    expect(status).toBe(200);
  });

  it("should serve an event file when only transcripts are hidden", async () => {
    mockDb.query.eventFiles.findFirst.mockResolvedValueOnce({
      ...FILE_ROW,
      event: makeEvent(TRANSCRIPTS_HIDDEN),
    });
    mockDb.query.users.findFirst.mockResolvedValue(userRow("user"));

    const { status } = await testRequest("/api/media/file/7", { headers: await auth("user") });

    expect(status).toBe(200);
  });
});

describe("GET /api/search — hidden topics", () => {
  const searchEvent = (overrides: Record<string, unknown>) =>
    makeEvent({ titleEn: "Retreat", sessions: [], ...overrides });

  it("should not match an event by its themes when topics are hidden", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([searchEvent(TOPICS_HIDDEN)]);

    const { body } = await testJson("/api/search?q=bodhicitta");

    expect(body.totalResults).toBe(0);
  });

  it("should match an event by its themes when topics are visible", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([searchEvent({})]);

    const { body } = await testJson("/api/search?q=bodhicitta");

    expect(body.totalResults).toBe(1);
  });

  it("should match by themes for an admin when topics are hidden", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([searchEvent(TOPICS_HIDDEN)]);

    const { body } = await testJson("/api/search?q=bodhicitta", { headers: await auth("admin") });

    expect(body.totalResults).toBe(1);
  });
});

describe("content routes — events embedded in user data", () => {
  it("should null the themes of the event in GET /api/content/last-played when topics are hidden", async () => {
    mockDb.query.userProgress.findMany.mockResolvedValueOnce([
      {
        trackId: 100,
        positionSeconds: 5,
        isCompleted: false,
        lastPlayed: new Date(),
        track: {
          id: 100,
          readAlongS3Key: "k.json",
          session: { id: 10, event: makeEvent({ ...TOPICS_HIDDEN, ...TRANSCRIPTS_HIDDEN }) },
        },
      },
    ]);

    const { body } = await testJson("/api/content/last-played", { headers: await auth("user") });

    expect(body.event.mainThemesEn).toBeNull();
    expect(body.track.readAlongS3Key).toBeUndefined();
  });

  it("should keep the themes in last-played for an admin", async () => {
    mockDb.query.userProgress.findMany.mockResolvedValueOnce([
      {
        trackId: 100,
        positionSeconds: 5,
        isCompleted: false,
        lastPlayed: new Date(),
        track: { id: 100, session: { id: 10, event: makeEvent(TOPICS_HIDDEN) } },
      },
    ]);

    const { body } = await testJson("/api/content/last-played", { headers: await auth("admin") });

    expect(body.event.mainThemesEn).toBe("Compassion");
  });

  it("should null the themes of events in GET /api/content/track-bookmarks when topics are hidden", async () => {
    mockDb.query.trackBookmarks.findMany.mockResolvedValueOnce([
      {
        id: 1,
        track: { id: 100, session: { id: 10, event: makeEvent(TOPICS_HIDDEN) } },
      },
    ]);

    const { body } = await testJson("/api/content/track-bookmarks", { headers: await auth("user") });

    expect(body[0].track.session.event.mainThemesEn).toBeNull();
  });

  it("should null the themes of events in GET /api/content/video-bookmarks when topics are hidden", async () => {
    mockDb.query.videoBookmarks.findMany.mockResolvedValueOnce([
      { id: 1, video: { id: 3, event: makeEvent(TOPICS_HIDDEN) } },
    ]);

    const { body } = await testJson("/api/content/video-bookmarks", { headers: await auth("user") });

    expect(body[0].video.event.mainThemesEn).toBeNull();
  });

  it("should null the themes of events in GET /api/content/event-bookmarks when topics are hidden", async () => {
    mockDb.query.eventBookmarks.findMany.mockResolvedValueOnce([
      { id: 1, event: makeEvent(TOPICS_HIDDEN) },
    ]);

    const { body } = await testJson("/api/content/event-bookmarks", { headers: await auth("user") });

    expect(body[0].event.mainThemesEn).toBeNull();
  });
});
