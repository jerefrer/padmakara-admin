import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────

// vi.hoisted ensures these variables are available when vi.mock factories run
// (vi.mock calls are hoisted to the top of the file before variable declarations)
const {
  mockProgressFindFirst,
  mockProgressFindMany,
  mockTrackFindFirst,
  mockEventFindFirst,
  mockEventBookmarkFindFirst,
  mockTrackBookmarkFindFirst,
  mockInsertReturning,
  mockUpdateReturning,
} = vi.hoisted(() => {
  return {
    mockProgressFindFirst: vi.fn(),
    mockProgressFindMany: vi.fn(),
    mockTrackFindFirst: vi.fn(),
    mockEventFindFirst: vi.fn(),
    mockEventBookmarkFindFirst: vi.fn(),
    mockTrackBookmarkFindFirst: vi.fn(),
    mockInsertReturning: vi.fn(),
    mockUpdateReturning: vi.fn(),
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      userProgress: {
        findFirst: (...args: any[]) => mockProgressFindFirst(...args),
        findMany: (...args: any[]) => mockProgressFindMany(...args),
      },
      tracks: {
        findFirst: (...args: any[]) => mockTrackFindFirst(...args),
      },
      events: {
        findFirst: (...args: any[]) => mockEventFindFirst(...args),
      },
      eventBookmarks: {
        findFirst: (...args: any[]) => mockEventBookmarkFindFirst(...args),
      },
      trackBookmarks: {
        findFirst: (...args: any[]) => mockTrackBookmarkFindFirst(...args),
      },
    },
    insert: () => ({
      values: () => ({
        returning: () => mockInsertReturning(),
        onConflictDoNothing: () => ({
          returning: () => mockInsertReturning(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mockUpdateReturning(),
        }),
      }),
    }),
  },
}));

// Stub URL-enrichment helpers so tests don't need to mock S3.
vi.mock("../../src/lib/teacher-utils.ts", () => ({
  resolveEventTeacherUrls: vi.fn(() => Promise.resolve()),
  resolveEventsTeacherUrls: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/group-utils.ts", () => ({
  resolveEventGroupUrls: vi.fn(() => Promise.resolve()),
  resolveEventsGroupUrls: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../src/services/auth.ts";

async function authHeader() {
  const token = await createAccessToken({
    sub: 1,
    email: "user@test.com",
    role: "user",
  });
  return { Authorization: `Bearer ${token}` };
}

async function adminAuthHeader() {
  const token = await createAccessToken({
    sub: 2,
    email: "admin@test.com",
    role: "admin",
  });
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Content progress routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/content/progress", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/progress", {
        method: "POST",
        body: JSON.stringify({ trackId: 42, positionSeconds: 30, durationSeconds: 100 }),
      });
      expect(status).toBe(401);
    });

    it("BE1 — inserts a new row when none exists", async () => {
      // Track fixture includes session→event so the draft status guard passes.
      mockTrackFindFirst.mockResolvedValueOnce({
        id: 42,
        session: { event: { status: "published" } },
      });
      mockProgressFindFirst.mockResolvedValueOnce(null);
      mockInsertReturning.mockResolvedValueOnce([{
        id: 1,
        userId: 1,
        trackId: 42,
        positionSeconds: 30,
        completionPct: 30,
        isCompleted: false,
        playCount: 1,
        totalListenSeconds: 30,
        lastPlayed: new Date().toISOString(),
        completedAt: null,
      }]);

      const { status, body } = await testJson("/api/content/progress", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 42, positionSeconds: 30, durationSeconds: 100 }),
      });

      expect(status).toBe(201);
      expect(body.trackId).toBe(42);
      expect(body.positionSeconds).toBe(30);
      expect(body.completionPct).toBe(30);
    });

    it("BE2 — updates an existing row and recomputes flags", async () => {
      // Track fixture includes session→event so the draft status guard passes.
      mockTrackFindFirst.mockResolvedValueOnce({
        id: 42,
        session: { event: { status: "published" } },
      });
      mockProgressFindFirst.mockResolvedValueOnce({
        id: 1,
        userId: 1,
        trackId: 42,
        positionSeconds: 50,
        completionPct: 50,
        isCompleted: false,
        playCount: 0,
        totalListenSeconds: 50,
        lastPlayed: new Date(0),
        completedAt: null,
      });
      mockUpdateReturning.mockResolvedValueOnce([{
        id: 1,
        userId: 1,
        trackId: 42,
        positionSeconds: 96,
        completionPct: 96,
        isCompleted: true,
        playCount: 1,
        totalListenSeconds: 96,
        lastPlayed: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }]);

      const { status, body } = await testJson("/api/content/progress", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 42, positionSeconds: 96, durationSeconds: 100 }),
      });

      expect(status).toBe(200);
      expect(body.completionPct).toBe(96);
      expect(body.isCompleted).toBe(true);
    });

    it("BE10 — returns 200 + {skipped:true} when trackId does not exist (no FK 500, no browser red)", async () => {
      mockTrackFindFirst.mockResolvedValueOnce(null);

      const { status, body } = await testJson("/api/content/progress", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 9999, positionSeconds: 30, durationSeconds: 100 }),
      });

      expect(status).toBe(200);
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe("unknown_track");
      expect(body.trackId).toBe(9999);
    });

    it("BE7 — rejects invalid body with 400", async () => {
      const { status } = await testJson("/api/content/progress", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: "not-a-number", positionSeconds: 30 }),
      });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });
  });

  describe("GET /api/content/progress/:trackId", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/progress/42");
      expect(status).toBe(401);
    });

    it("BE3 — returns the row when it exists", async () => {
      mockProgressFindFirst.mockResolvedValueOnce({
        id: 1,
        userId: 1,
        trackId: 42,
        positionSeconds: 50,
        completionPct: 50,
        isCompleted: false,
        playCount: 0,
        totalListenSeconds: 50,
        lastPlayed: new Date("2026-05-08T10:00:00Z").toISOString(),
        completedAt: null,
      });

      const { status, body } = await testJson("/api/content/progress/42", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body.trackId).toBe(42);
      expect(body.lastPlayed).toBeDefined();
    });

    it("BE4 — returns the zero shape (no lastPlayed) when row missing", async () => {
      mockProgressFindFirst.mockResolvedValueOnce(null);

      const { status, body } = await testJson("/api/content/progress/99", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toEqual({ positionSeconds: 0, completionPct: 0, isCompleted: false });
      expect(body.lastPlayed).toBeUndefined();
    });
  });

  describe("GET /api/content/last-played", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/last-played");
      expect(status).toBe(401);
    });

    it("BE5 — returns null when user has no progress rows", async () => {
      mockProgressFindFirst.mockResolvedValueOnce(null);

      const { status, body } = await testJson("/api/content/last-played", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toBeNull();
    });

    it("BE6 — returns most recent row joined with track/session/event", async () => {
      mockProgressFindFirst.mockResolvedValueOnce({
        id: 1,
        userId: 1,
        trackId: 42,
        positionSeconds: 47,
        isCompleted: false,
        lastPlayed: new Date("2026-05-08T10:00:00Z").toISOString(),
        track: {
          id: 42,
          title: "Track A",
          session: {
            id: 7,
            name: "Morning",
            event: { id: 99, titleEn: "Spring Retreat" },
          },
        },
      });

      const { status, body } = await testJson("/api/content/last-played", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body.trackId).toBe(42);
      expect(body.positionSeconds).toBe(47);
      expect(body.track.title).toBe("Track A");
      expect(body.session.name).toBe("Morning");
      expect(body.event.titleEn).toBe("Spring Retreat");
    });
  });

  describe("GET /api/content/progress (all)", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/progress");
      expect(status).toBe(401);
    });

    it("BE8 — returns empty array when user has no rows", async () => {
      mockProgressFindMany.mockResolvedValueOnce([]);

      const { status, body } = await testJson("/api/content/progress", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it("BE9 — returns all rows ordered by lastPlayed desc", async () => {
      mockProgressFindMany.mockResolvedValueOnce([
        {
          id: 1,
          userId: 1,
          trackId: 42,
          positionSeconds: 47,
          completionPct: 23,
          isCompleted: false,
          playCount: 1,
          totalListenSeconds: 47,
          lastPlayed: new Date("2026-05-08T10:00:00Z").toISOString(),
          completedAt: null,
        },
        {
          id: 2,
          userId: 1,
          trackId: 43,
          positionSeconds: 12,
          completionPct: 6,
          isCompleted: false,
          playCount: 1,
          totalListenSeconds: 12,
          lastPlayed: new Date("2026-05-07T10:00:00Z").toISOString(),
          completedAt: null,
        },
      ]);

      const { status, body } = await testJson("/api/content/progress", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].trackId).toBe(42);
      expect(body[1].trackId).toBe(43);
    });
  });
});

// ─── Draft event visibility — write endpoint guards ───────────────────────────
//
// Three POST endpoints bypass checkEventAccess (they are write-only paths that
// the normal event-access gate does not cover). This describe block verifies
// that each one refuses non-admin callers when the target event is in draft.

describe("content write endpoints — draft guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /api/content/event-bookmarks ──────────────────────────────────────

  it("returns 404 when a regular user bookmarks a draft event", async () => {
    // Arrange: event exists but is a draft — the guard must reject it.
    mockEventFindFirst.mockResolvedValueOnce({ id: 42, status: "draft" });

    // Act
    const { status } = await testJson("/api/content/event-bookmarks", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ eventId: 42 }),
    });

    // Assert
    expect(status).toBe(404);
  });

  it("allows an admin to bookmark a draft event", async () => {
    // Arrange: same draft event; admin caller.
    // The guard must pass, insert fires, then findFirst returns the bookmark row.
    mockEventFindFirst.mockResolvedValueOnce({ id: 42, status: "draft" });
    mockInsertReturning.mockResolvedValueOnce([
      { id: 1, userId: 2, eventId: 42, createdAt: new Date() },
    ]);
    mockEventBookmarkFindFirst.mockResolvedValueOnce({
      id: 1,
      userId: 2,
      eventId: 42,
      createdAt: new Date(),
      event: {
        id: 42,
        status: "draft",
        eventTeachers: [],
        eventRetreatGroups: [],
        eventPlaces: [],
        audience: null,
        eventType: null,
      },
    });

    // Act
    const { status } = await testJson("/api/content/event-bookmarks", {
      method: "POST",
      headers: await adminAuthHeader(),
      body: JSON.stringify({ eventId: 42 }),
    });

    // Assert
    expect([200, 201]).toContain(status);
  });

  // ── POST /api/content/progress ────────────────────────────────────────────

  it("returns 404 when a regular user posts progress on a draft event's track", async () => {
    // Arrange: track exists; its parent session belongs to a draft event.
    mockTrackFindFirst.mockResolvedValueOnce({
      id: 7,
      session: { event: { status: "draft" } },
    });

    // Act
    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ trackId: 7, positionSeconds: 30, durationSeconds: 120 }),
    });

    // Assert
    expect(status).toBe(404);
  });

  it("allows an admin to post progress on a draft event's track", async () => {
    // Arrange: same draft-event track; admin caller — guard must pass.
    mockTrackFindFirst.mockResolvedValueOnce({
      id: 7,
      session: { event: { status: "draft" } },
    });
    mockProgressFindFirst.mockResolvedValueOnce(null);
    mockInsertReturning.mockResolvedValueOnce([{
      id: 10,
      userId: 2,
      trackId: 7,
      positionSeconds: 30,
      completionPct: 25,
      isCompleted: false,
      playCount: 1,
      totalListenSeconds: 30,
      lastPlayed: new Date().toISOString(),
      completedAt: null,
    }]);

    // Act
    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await adminAuthHeader(),
      body: JSON.stringify({ trackId: 7, positionSeconds: 30, durationSeconds: 120 }),
    });

    // Assert
    expect([200, 201]).toContain(status);
  });

  // ── POST /api/content/track-bookmarks ─────────────────────────────────────

  it("returns 404 when a regular user bookmarks a track from a draft event", async () => {
    // Arrange: preliminary track lookup returns a track whose event is a draft.
    mockTrackFindFirst.mockResolvedValueOnce({
      id: 7,
      session: { event: { status: "draft" } },
    });

    // Act
    const { status } = await testJson("/api/content/track-bookmarks", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ trackId: 7 }),
    });

    // Assert
    expect(status).toBe(404);
  });

  it("allows an admin to bookmark a track from a draft event", async () => {
    // Arrange: same draft-event track; admin caller — guard must pass.
    mockTrackFindFirst.mockResolvedValueOnce({
      id: 7,
      session: { event: { status: "draft" } },
    });
    mockInsertReturning.mockResolvedValueOnce([
      { id: 5, userId: 2, trackId: 7, createdAt: new Date() },
    ]);
    mockTrackBookmarkFindFirst.mockResolvedValueOnce({
      id: 5,
      userId: 2,
      trackId: 7,
      createdAt: new Date(),
      track: {
        id: 7,
        session: {
          event: {
            id: 42,
            status: "draft",
            eventTeachers: [],
            eventRetreatGroups: [],
          },
        },
      },
    });

    // Act
    const { status } = await testJson("/api/content/track-bookmarks", {
      method: "POST",
      headers: await adminAuthHeader(),
      body: JSON.stringify({ trackId: 7 }),
    });

    // Assert
    expect([200, 201]).toContain(status);
  });
});
