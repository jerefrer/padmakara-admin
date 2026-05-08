import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockInsertReturning = vi.fn();
const mockDeleteReturning = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      trackBookmarks: {
        findMany: (...args: any[]) => mockFindMany(...args),
        findFirst: (...args: any[]) => mockFindFirst(...args),
      },
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => mockInsertReturning(),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => mockDeleteReturning(),
      }),
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

function makeTrack(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    title: "Track 1 — Refuge",
    trackNumber: 1,
    durationSeconds: 1800,
    sessionId: 100,
    session: {
      id: 100,
      titleEn: "Morning Session",
      titlePt: null,
      sessionDate: "2024-04-15",
      eventId: 42,
      event: {
        id: 42,
        eventCode: "2024.04.15-GROUP",
        titleEn: "Spring Retreat 2024",
        titlePt: null,
        startDate: "2024-04-15",
        endDate: "2024-04-20",
        eventTeachers: [],
        eventRetreatGroups: [],
      },
    },
    ...overrides,
  };
}

function makeBookmark(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 1,
    trackId: 7,
    createdAt: new Date("2026-05-01T12:00:00Z"),
    track: makeTrack(),
    ...overrides,
  };
}

async function authHeader() {
  const token = await createAccessToken({
    sub: 1,
    email: "user@test.com",
    role: "user",
  });
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Track bookmarks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/content/track-bookmarks", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/track-bookmarks");
      expect(status).toBe(401);
    });

    it("returns the user's bookmarked tracks with parent event", async () => {
      mockFindMany.mockResolvedValueOnce([makeBookmark()]);
      const { status, body } = await testJson("/api/content/track-bookmarks", {
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].trackId).toBe(7);
      expect(body[0].track.title).toBe("Track 1 — Refuge");
      expect(body[0].track.session.event.id).toBe(42);
    });

    it("returns empty array when no bookmarks", async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const { status, body } = await testJson("/api/content/track-bookmarks", {
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe("POST /api/content/track-bookmarks", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/track-bookmarks", {
        method: "POST",
        body: JSON.stringify({ trackId: 7 }),
      });
      expect(status).toBe(401);
    });

    it("returns 400 when trackId missing", async () => {
      const { status } = await testJson("/api/content/track-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
    });

    it("creates a bookmark and returns 201", async () => {
      mockInsertReturning.mockResolvedValueOnce([
        { id: 1, userId: 1, trackId: 7, createdAt: new Date() },
      ]);
      mockFindFirst.mockResolvedValueOnce(makeBookmark());

      const { status, body } = await testJson("/api/content/track-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 7 }),
      });
      expect(status).toBe(201);
      expect(body.trackId).toBe(7);
    });

    it("is idempotent: returns 200 with existing row when already bookmarked", async () => {
      mockInsertReturning.mockResolvedValueOnce([]);
      mockFindFirst.mockResolvedValueOnce(makeBookmark());

      const { status, body } = await testJson("/api/content/track-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 7 }),
      });
      expect(status).toBe(200);
      expect(body.trackId).toBe(7);
    });

    it("returns 404 when track does not exist", async () => {
      mockInsertReturning.mockResolvedValueOnce([]);
      mockFindFirst.mockResolvedValueOnce(null);
      const { status } = await testJson("/api/content/track-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ trackId: 9999 }),
      });
      expect(status).toBe(404);
    });
  });

  describe("DELETE /api/content/track-bookmarks/:trackId", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/track-bookmarks/7", {
        method: "DELETE",
      });
      expect(status).toBe(401);
    });

    it("deletes a bookmark and returns the deleted row", async () => {
      mockDeleteReturning.mockResolvedValueOnce([
        { id: 1, userId: 1, trackId: 7, createdAt: new Date() },
      ]);
      const { status, body } = await testJson("/api/content/track-bookmarks/7", {
        method: "DELETE",
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body.trackId).toBe(7);
    });

    it("returns 404 when no bookmark exists", async () => {
      mockDeleteReturning.mockResolvedValueOnce([]);
      const { status } = await testJson("/api/content/track-bookmarks/7", {
        method: "DELETE",
        headers: await authHeader(),
      });
      expect(status).toBe(404);
    });
  });
});
