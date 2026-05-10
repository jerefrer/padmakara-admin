import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockTrackFindFirst = vi.fn();
const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      userProgress: {
        findFirst: (...args: any[]) => mockFindFirst(...args),
        findMany: (...args: any[]) => mockFindMany(...args),
      },
      tracks: {
        findFirst: (...args: any[]) => mockTrackFindFirst(...args),
      },
    },
    insert: () => ({
      values: () => ({
        returning: () => mockInsertReturning(),
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

import { createAccessToken } from "../../src/services/auth.ts";

async function authHeader() {
  const token = await createAccessToken({
    sub: 1,
    email: "user@test.com",
    role: "user",
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
      mockTrackFindFirst.mockResolvedValueOnce({ id: 42 });
      mockFindFirst.mockResolvedValueOnce(null);
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
      mockTrackFindFirst.mockResolvedValueOnce({ id: 42 });
      mockFindFirst.mockResolvedValueOnce({
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
      mockFindFirst.mockResolvedValueOnce({
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
      mockFindFirst.mockResolvedValueOnce(null);

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
      mockFindFirst.mockResolvedValueOnce(null);

      const { status, body } = await testJson("/api/content/last-played", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toBeNull();
    });

    it("BE6 — returns most recent row joined with track/session/event", async () => {
      mockFindFirst.mockResolvedValueOnce({
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
      mockFindMany.mockResolvedValueOnce([]);

      const { status, body } = await testJson("/api/content/progress", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it("BE9 — returns all rows ordered by lastPlayed desc", async () => {
      mockFindMany.mockResolvedValueOnce([
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
