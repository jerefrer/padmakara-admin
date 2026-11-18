import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";
import { projectRow, storageKeyPaths } from "../query-projection.ts";

/**
 * Storage keys (track, file, video master, slide images, group and event photos)
 * never reach a client: the files are served by presigned or proxied URLs, and a
 * key names the bucket layout. Every fixture row below carries its real key
 * columns; the mocked database applies each query's `columns`/`with` like Drizzle
 * (see query-projection.ts), so the test fails whether a key is selected and kept
 * or loaded and never stripped.
 */

const { fixtures } = vi.hoisted(() => {
  const at = new Date("2026-01-01T00:00:00Z");
  const group = {
    id: 3,
    nameEn: "Group",
    namePt: null,
    abbreviation: "GRP",
    slug: "grp",
    description: null,
    logoUrl: null,
    avatarS3Key: "groups/avatars/3-secret.webp",
    heroS3Key: "groups/heroes/3-secret.webp",
    heroMobileS3Key: "groups/heroes/3-secret-m.webp",
    heroOriginalS3Key: "groups/heroes/3-secret-original.jpg",
    heroFocalX: 50,
    heroFocalY: 50,
    heroScale: 100,
    heroCrop: null,
    heroGrayscale: false,
    heroFrameOverrides: null,
    avatarUpdatedAt: at,
    heroUpdatedAt: at,
    displayOrder: 0,
    createdAt: at,
    updatedAt: at,
  };
  const teacher = {
    id: 2,
    name: "Teacher",
    abbreviation: "TCH",
    aliases: [],
    photoUrl: null,
    avatarS3Key: "teachers/avatars/2-secret.webp",
    heroS3Key: "teachers/heroes/2-secret.webp",
    heroMobileS3Key: "teachers/heroes/2-secret-m.webp",
    heroOriginalS3Key: "teachers/heroes/2-secret-original.jpg",
    heroFocalX: 50,
    heroFocalY: 50,
    heroScale: 100,
    heroFrameOverrides: null,
    avatarUpdatedAt: at,
    heroUpdatedAt: at,
  };
  const track = {
    id: 7,
    sessionId: 100,
    title: "002 initial prayers",
    titleEn: "Initial prayers",
    titlePt: null,
    titleEnReviewed: true,
    titlePtReviewed: true,
    trackNumber: 2,
    position: null,
    speaker: "TCH",
    languages: ["en"],
    originalLanguage: "en",
    isTranslation: false,
    isPractice: false,
    fileFormat: "mp3",
    originalTrackId: null,
    s3Key: "events/20100618_19-KTGR/002 initial prayers.mp3",
    durationSeconds: 1800,
    fileSizeBytes: 1000,
    originalFilename: "002 initial prayers.mp3",
    bitrateKbps: 128,
    sampleRateHz: 44100,
    channels: 2,
    readAlongS3Key: "read-along/7-secret.json",
    createdAt: at,
    updatedAt: at,
  };
  const session = {
    id: 100,
    eventId: 42,
    sessionNumber: 1,
    titleEn: "Morning",
    titlePt: null,
    sessionDate: "2010-06-18",
    timePeriod: "morning",
  };
  const video = {
    id: 5,
    eventId: 42,
    bunnyVideoId: "bunny-guid",
    position: 0,
    titleEn: "Part 1",
    titlePt: null,
    titleEnReviewed: true,
    titlePtReviewed: true,
    videoDate: "2010-06-18",
    durationSeconds: 3600,
    posterUrl: null,
    slides: {
      intro: [],
      outro: [{ id: "s1", lines: [{ id: "l1", kind: "image", s3Key: "@builtin/padmakara-logo.png" }] }],
    },
    sessionId: 100,
    hasBurnedSlides: false,
    burnStatus: "done",
    burnJobId: "batch-job",
    masterS3Key: "videos/masters/5-secret.mp4",
    burnError: null,
    burnedIntroMs: 8000,
    burnMasterBytes: 1,
    burnPeakDiskBytes: 1,
    createdAt: at,
    updatedAt: at,
  };
  const eventFile = {
    id: 9,
    eventId: 42,
    sessionId: null,
    originalFilename: "notes.pdf",
    s3Key: "events/20100618_19-KTGR/files/notes-secret.pdf",
    fileType: "document",
    extension: "pdf",
    fileSizeBytes: 10,
    language: "en",
    sensitive: false,
    title: "Notes",
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
  };
  const transcript = {
    id: 11,
    eventId: 42,
    language: "en",
    pageCount: 3,
    status: "final",
    isExcerpt: false,
    published: true,
    originalFilename: "transcript.pdf",
    s3Key: "events/20100618_19-KTGR/transcripts/secret.pdf",
    fileSizeBytes: 10,
    createdAt: at,
    updatedAt: at,
  };
  const audience = { id: 1, slug: "free-anyone" };
  const event = {
    id: 42,
    eventCode: "20100618_19-KTGR",
    titleEn: "Retreat",
    titlePt: null,
    startDate: "2010-06-18",
    endDate: "2010-06-19",
    status: "published",
    audienceId: 1,
    featuredAt: at,
    avatarS3Key: "events/20100618_19-KTGR/avatar-secret.webp",
    heroS3Key: "events/20100618_19-KTGR/hero-secret.webp",
    heroMobileS3Key: "events/20100618_19-KTGR/hero-secret-m.webp",
    heroOriginalS3Key: "events/20100618_19-KTGR/hero-secret-original.jpg",
    heroUpdatedAt: at,
    audience,
    eventType: null,
    eventTeachers: [{ eventId: 42, teacherId: 2, teacher }],
    eventRetreatGroups: [{ eventId: 42, retreatGroupId: 3, retreatGroup: group }],
    eventPlaces: [],
    eventOrganizers: [],
    eventPublications: [],
    videos: [video],
    sessions: [{ ...session, tracks: [track] }],
    transcripts: [transcript],
    eventFiles: [eventFile],
  };
  const trackInContext = { ...track, session: { ...session, event } };
  return {
    fixtures: {
      event,
      group,
      session: { ...session, tracks: [track], event },
      track: trackInContext,
      video: { ...video, event },
      user: { id: 1, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null },
      progress: { id: 1, userId: 1, trackId: 7, positionSeconds: 10, isCompleted: false, lastPlayed: at, track: trackInContext },
      grant: { userId: 1, eventId: 42, createdAt: at },
    },
  };
});

/** A Drizzle relational table mock: every query returns the fixture, projected. */
function table(row: () => unknown) {
  return {
    findFirst: vi.fn((query?: object) => Promise.resolve(projectRow(row(), query))),
    findMany: vi.fn((query?: object) => Promise.resolve([projectRow(row(), query)])),
  };
}

/** A thenable select builder: `where` yields `filtered`, a join yields nothing. */
interface SelectChain extends Promise<unknown[]> {
  where: () => SelectChain;
  innerJoin: () => SelectChain;
  leftJoin: () => SelectChain;
  orderBy: () => SelectChain;
  limit: () => SelectChain;
}

function selectChain(rows: unknown[], filtered: unknown[]): SelectChain {
  const chain: SelectChain = Object.assign(Promise.resolve(rows), {
    where: vi.fn(() => selectChain(filtered, filtered)),
    innerJoin: vi.fn(() => selectChain([], [])),
    leftJoin: vi.fn(() => selectChain([], [])),
    orderBy: vi.fn(() => selectChain(rows, filtered)),
    limit: vi.fn(() => selectChain(rows, filtered)),
  });
  return chain;
}

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: table(() => fixtures.event),
      audiences: table(() => fixtures.event.audience),
      users: table(() => fixtures.user),
      sessions: table(() => fixtures.session),
      tracks: table(() => fixtures.track),
      retreatGroups: table(() => fixtures.group),
      userGroupMemberships: { findMany: vi.fn(() => Promise.resolve([])), findFirst: vi.fn(() => Promise.resolve(null)) },
      eventAccessGrants: table(() => fixtures.grant),
      userProgress: table(() => fixtures.progress),
      bookmarks: table(() => ({ id: 1, userId: 1, trackId: 7, positionSeconds: 5, track: fixtures.track })),
      trackBookmarks: table(() => ({ id: 1, userId: 1, trackId: 7, track: fixtures.track })),
      videoBookmarks: table(() => ({ id: 1, userId: 1, videoId: 5, positionSeconds: 5, note: null, video: fixtures.video })),
      eventBookmarks: table(() => ({ id: 1, userId: 1, eventId: 42, event: fixtures.event })),
    },
    // Teacher speaker map (awaited `from`), group → event links (`where`) and the
    // publications reached through groups (joined: none)
    select: vi.fn(() => ({ from: vi.fn(() => selectChain([], [{ eventId: 42 }])) })),
  },
}));

vi.mock("../../src/services/s3.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/s3.ts")>()),
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://storage.example/signed")),
}));

// Who may open what is tested elsewhere: here every caller is let in.
vi.mock("../../src/services/access.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/access.ts")>()),
  checkEventAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  filterAccessibleEvents: vi.fn((_user: unknown, events: unknown[]) => Promise.resolve(events)),
}));

import { createAccessToken } from "../../src/services/auth.ts";

async function userHeaders(): Promise<Record<string, string>> {
  const token = await createAccessToken({ sub: 1, email: "user@example.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

const ROUTES: Array<{ path: string; signedIn: boolean }> = [
  { path: "/api/events/public", signedIn: false },
  { path: "/api/events/public/42", signedIn: false },
  { path: "/api/events/featured", signedIn: false },
  { path: "/api/events", signedIn: true },
  { path: "/api/events/42", signedIn: true },
  { path: "/api/events/sessions/100", signedIn: true },
  { path: "/api/events/tracks/7", signedIn: true },
  { path: "/api/groups", signedIn: true },
  { path: "/api/groups/3/events", signedIn: true },
  { path: "/api/teachings/mine", signedIn: true },
  { path: "/api/content/last-played", signedIn: true },
  { path: "/api/content/bookmarks", signedIn: true },
  { path: "/api/content/track-bookmarks", signedIn: true },
  { path: "/api/content/video-bookmarks", signedIn: true },
  { path: "/api/content/event-bookmarks", signedIn: true },
];

describe("client payloads — storage keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(ROUTES)("should not return any storage key when serving GET $path", async ({ path, signedIn }) => {
    // Arrange
    const headers = signedIn ? await userHeaders() : {};

    // Act
    const { status, body } = await testJson(path, { headers });

    // Assert
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toMatch(/"id":(42|3|7|1),/);
    expect(storageKeyPaths(body)).toEqual([]);
  });

  it("should keep hasReadAlong on the tracks once the read-along key is dropped", async () => {
    // Act
    const { body } = await testJson("/api/events/public/42");

    // Assert
    expect(body.sessions[0].tracks[0].hasReadAlong).toBe(true);
  });

  it("should keep the video fields the app reads", async () => {
    // Act
    const { body } = await testJson("/api/events/public/42");

    // Assert
    expect(body.videos[0]).toMatchObject({
      id: 5,
      eventId: 42,
      bunnyVideoId: "bunny-guid",
      position: 0,
      titleEn: "Part 1",
      videoDate: "2010-06-18",
      durationSeconds: 3600,
    });
    expect(body.videos[0]).not.toHaveProperty("slides");
  });
});
