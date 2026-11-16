import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// Bookmark and progress routes must apply the event's AUDIENCE rule, not only its
// status: a signed-in account outside the audience may neither write rows on the
// event's tracks nor read the event's metadata or track rows back through bookmarks
// it saved while it still had access. The real access service runs here; only the
// database is mocked.

const { q, mockInsert, mockUpdate } = vi.hoisted(() => ({
  q: {
    tracksFindFirst: vi.fn(),
    eventsFindFirst: vi.fn(),
    usersFindFirst: vi.fn(),
    attendanceFindFirst: vi.fn(),
    grantFindFirst: vi.fn(),
    membershipFindFirst: vi.fn(),
    progressFindFirst: vi.fn(),
    progressFindMany: vi.fn(),
    bookmarksFindMany: vi.fn(),
    eventBookmarksFindMany: vi.fn(),
    eventBookmarksFindFirst: vi.fn(),
    trackBookmarksFindMany: vi.fn(),
    trackBookmarksFindFirst: vi.fn(),
    videoBookmarksFindMany: vi.fn(),
  },
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      tracks: { findFirst: (...a: any[]) => q.tracksFindFirst(...a) },
      events: { findFirst: (...a: any[]) => q.eventsFindFirst(...a) },
      users: { findFirst: (...a: any[]) => q.usersFindFirst(...a) },
      userEventAttendance: { findFirst: (...a: any[]) => q.attendanceFindFirst(...a) },
      eventAccessGrants: { findFirst: (...a: any[]) => q.grantFindFirst(...a) },
      userGroupMemberships: { findFirst: (...a: any[]) => q.membershipFindFirst(...a) },
      userProgress: {
        findFirst: (...a: any[]) => q.progressFindFirst(...a),
        findMany: (...a: any[]) => q.progressFindMany(...a),
      },
      bookmarks: { findMany: (...a: any[]) => q.bookmarksFindMany(...a) },
      eventBookmarks: {
        findMany: (...a: any[]) => q.eventBookmarksFindMany(...a),
        findFirst: (...a: any[]) => q.eventBookmarksFindFirst(...a),
      },
      trackBookmarks: {
        findMany: (...a: any[]) => q.trackBookmarksFindMany(...a),
        findFirst: (...a: any[]) => q.trackBookmarksFindFirst(...a),
      },
      videoBookmarks: { findMany: (...a: any[]) => q.videoBookmarksFindMany(...a) },
    },
    // filterAccessibleEvents loads the caller's grants and the group rule the linked
    // groups with `select().from().where()`: none here.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: (v: unknown) => {
        mockInsert(v);
        const rows = [{ id: 1, userId: 1, ...(v as object), createdAt: new Date() }];
        return {
          returning: () => Promise.resolve(rows),
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
        };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        mockUpdate(v);
        return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
      },
    }),
  },
}));

vi.mock("../../src/lib/teacher-utils.ts", () => ({
  resolveEventTeacherUrls: vi.fn(() => Promise.resolve()),
  resolveEventsTeacherUrls: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/group-utils.ts", () => ({
  resolveEventGroupUrls: vi.fn(() => Promise.resolve()),
  resolveEventsGroupUrls: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../src/services/auth.ts";

const RESTRICTED_EVENT = {
  id: 42,
  titleEn: "Initiation teaching",
  status: "published",
  audienceId: 7,
  audience: { slug: "restricted" },
};
const PUBLIC_EVENT = {
  id: 43,
  titleEn: "Open talk",
  status: "published",
  audienceId: 1,
  audience: { slug: "free-anyone" },
};

function trackOf(event: Record<string, unknown>, id: number) {
  return {
    id,
    title: `Track ${id}`,
    s3Key: `events/${event.id}/track-${id}.mp3`,
    session: { id: 100 + id, titleEn: "Morning", event: { ...event } },
  };
}

async function userHeader() {
  const token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.resetAllMocks();
  // A signed-in account without membership, grant or attendance
  q.usersFindFirst.mockResolvedValue({
    id: 1,
    role: "user",
    subscriptionStatus: "none",
    subscriptionExpiresAt: null,
  });
  q.attendanceFindFirst.mockResolvedValue(undefined);
  q.grantFindFirst.mockResolvedValue(undefined);
  q.membershipFindFirst.mockResolvedValue(undefined);
});

describe("content writes — audience check", () => {
  it("should return 404 and write nothing when posting progress on a track of an event outside the caller's audience", async () => {
    q.tracksFindFirst.mockResolvedValue(trackOf(RESTRICTED_EVENT, 7));

    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 7, positionSeconds: 30, durationSeconds: 100 }),
    });

    expect(status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("should save progress on a track of an event the caller may open", async () => {
    q.tracksFindFirst.mockResolvedValue(trackOf(PUBLIC_EVENT, 8));
    q.progressFindFirst.mockResolvedValue(null);

    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 8, positionSeconds: 30, durationSeconds: 100 }),
    });

    expect(status).toBe(201);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("should return 404 and write nothing when bookmarking a position in a track outside the caller's audience", async () => {
    q.tracksFindFirst.mockResolvedValue(trackOf(RESTRICTED_EVENT, 7));

    const { status } = await testJson("/api/content/bookmarks", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 7, positionSeconds: 30 }),
    });

    expect(status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("should save a position bookmark in a track the caller may open", async () => {
    q.tracksFindFirst.mockResolvedValue(trackOf(PUBLIC_EVENT, 8));

    const { status, body } = await testJson("/api/content/bookmarks", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 8, positionSeconds: 30 }),
    });

    expect(status).toBe(201);
    expect(body.trackId).toBe(8);
  });

  it("should return 404 and write nothing when bookmarking an event outside the caller's audience", async () => {
    q.eventsFindFirst.mockResolvedValue({ ...RESTRICTED_EVENT });
    q.eventBookmarksFindFirst.mockResolvedValue({
      id: 1,
      userId: 1,
      eventId: 42,
      event: { ...RESTRICTED_EVENT, eventTeachers: [{ teacher: { name: "Lama" } }] },
    });

    const { status, body } = await testJson("/api/content/event-bookmarks", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ eventId: 42 }),
    });

    expect(status).toBe(404);
    expect(body.event).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("should return 404 and write nothing when bookmarking a track outside the caller's audience", async () => {
    q.tracksFindFirst.mockResolvedValue(trackOf(RESTRICTED_EVENT, 7));
    q.trackBookmarksFindFirst.mockResolvedValue({
      id: 1,
      userId: 1,
      trackId: 7,
      track: trackOf(RESTRICTED_EVENT, 7),
    });

    const { status, body } = await testJson("/api/content/track-bookmarks", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 7 }),
    });

    expect(status).toBe(404);
    expect(body.track).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("should return 404 and write nothing for an audience the caller's lapsed subscription no longer opens", async () => {
    q.tracksFindFirst.mockResolvedValue(
      trackOf({ ...PUBLIC_EVENT, id: 44, audience: { slug: "free-subscribers" } }, 9),
    );

    const { status } = await testJson("/api/content/track-bookmarks", {
      method: "POST",
      headers: await userHeader(),
      body: JSON.stringify({ trackId: 9 }),
    });

    expect(status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("content reads — rows of events the caller can no longer open", () => {
  it("should leave event bookmarks of events outside the caller's audience out of the list", async () => {
    q.eventBookmarksFindMany.mockResolvedValue([
      { id: 1, userId: 1, eventId: 42, event: { ...RESTRICTED_EVENT } },
      { id: 2, userId: 1, eventId: 43, event: { ...PUBLIC_EVENT } },
    ]);

    const { status, body } = await testJson("/api/content/event-bookmarks", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body.map((b: any) => b.eventId)).toEqual([43]);
  });

  it("should leave track bookmarks of events outside the caller's audience out of the list", async () => {
    q.trackBookmarksFindMany.mockResolvedValue([
      { id: 1, userId: 1, trackId: 7, track: trackOf(RESTRICTED_EVENT, 7) },
      { id: 2, userId: 1, trackId: 8, track: trackOf(PUBLIC_EVENT, 8) },
    ]);

    const { status, body } = await testJson("/api/content/track-bookmarks", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body.map((b: any) => b.trackId)).toEqual([8]);
    // The audience is loaded for the check only: the payload keeps its shape
    expect(body[0].track.session.event.audience).toBeUndefined();
  });

  it("should leave position bookmarks of events outside the caller's audience out of the list", async () => {
    q.bookmarksFindMany.mockResolvedValue([
      { id: 1, userId: 1, trackId: 7, positionSeconds: 5, track: trackOf(RESTRICTED_EVENT, 7) },
      { id: 2, userId: 1, trackId: 8, positionSeconds: 6, track: trackOf(PUBLIC_EVENT, 8) },
    ]);

    const { status, body } = await testJson("/api/content/bookmarks", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body.map((b: any) => b.trackId)).toEqual([8]);
    expect(body[0].track.session).toBeUndefined();
  });

  it("should leave video bookmarks of events outside the caller's audience out of the list", async () => {
    q.videoBookmarksFindMany.mockResolvedValue([
      { id: 1, userId: 1, videoId: 5, video: { id: 5, event: { ...RESTRICTED_EVENT } } },
      { id: 2, userId: 1, videoId: 6, video: { id: 6, event: { ...PUBLIC_EVENT } } },
    ]);

    const { status, body } = await testJson("/api/content/video-bookmarks", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body.map((b: any) => b.videoId)).toEqual([6]);
    expect(body[0].video.event.audience).toBeUndefined();
  });

  it("should skip a last-played track of an event outside the caller's audience", async () => {
    q.progressFindMany.mockResolvedValue([
      { trackId: 7, positionSeconds: 10, isCompleted: false, lastPlayed: new Date(), track: trackOf(RESTRICTED_EVENT, 7) },
      { trackId: 8, positionSeconds: 20, isCompleted: false, lastPlayed: new Date(0), track: trackOf(PUBLIC_EVENT, 8) },
    ]);

    const { status, body } = await testJson("/api/content/last-played", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body.trackId).toBe(8);
    expect(body.event.id).toBe(43);
    expect(body.event.audience).toBeUndefined();
  });

  it("should return null from last-played when every recent track is outside the caller's audience", async () => {
    q.progressFindMany.mockResolvedValue([
      { trackId: 7, positionSeconds: 10, isCompleted: false, lastPlayed: new Date(), track: trackOf(RESTRICTED_EVENT, 7) },
    ]);

    const { status, body } = await testJson("/api/content/last-played", {
      headers: await userHeader(),
    });

    expect(status).toBe(200);
    expect(body).toBeNull();
  });
});
