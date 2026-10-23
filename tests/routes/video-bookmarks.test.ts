import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

const {
  mockFindMany,
  mockBookmarkFindFirst,
  mockEventVideoFindFirst,
  mockUserFindFirst,
  mockInsertReturning,
  mockInsertValues,
  mockUpdateReturning,
  mockDeleteReturning,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockBookmarkFindFirst: vi.fn(),
  mockEventVideoFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteReturning: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      videoBookmarks: {
        findMany: (...args: any[]) => mockFindMany(...args),
        findFirst: (...args: any[]) => mockBookmarkFindFirst(...args),
      },
      eventVideos: { findFirst: (...args: any[]) => mockEventVideoFindFirst(...args) },
      users: { findFirst: (...args: any[]) => mockUserFindFirst(...args) },
    },
    insert: () => ({
      values: (v: any) => {
        mockInsertValues(v);
        return { returning: () => mockInsertReturning() };
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => mockUpdateReturning() }) }),
    }),
    delete: () => ({
      where: () => ({ returning: () => mockDeleteReturning() }),
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

function makeBookmark(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 1,
    videoId: 5,
    positionSeconds: 754,
    note: "Key passage",
    createdAt: new Date("2026-05-01T12:00:00Z"),
    video: {
      id: 5,
      eventId: 42,
      titleEn: "Part 1",
      titlePt: null,
      event: {
        id: 42,
        titleEn: "Spring Retreat 2024",
        eventTeachers: [],
        eventRetreatGroups: [],
        eventOrganizers: [],
      },
    },
    ...overrides,
  };
}

function publicEventVideo(overrides: Record<string, any> = {}) {
  return {
    id: 5,
    eventId: 42,
    event: { id: 42, status: "published", audience: { slug: "free-anyone" }, audienceId: 1 },
    ...overrides,
  };
}

function activeUser() {
  return { id: 1, role: "user", subscriptionStatus: "active", subscriptionExpiresAt: null };
}

async function authHeader() {
  const token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

describe("Video bookmarks routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("GET /api/content/video-bookmarks", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/video-bookmarks");
      expect(status).toBe(401);
    });

    it("returns the user's bookmarks with video and event", async () => {
      mockFindMany.mockResolvedValueOnce([makeBookmark()]);
      const { status, body } = await testJson("/api/content/video-bookmarks", {
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].positionSeconds).toBe(754);
      expect(body[0].video.event.id).toBe(42);
    });

    it("returns an empty array when there are no bookmarks", async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const { body } = await testJson("/api/content/video-bookmarks", {
        headers: await authHeader(),
      });
      expect(body).toEqual([]);
    });
  });

  describe("POST /api/content/video-bookmarks", () => {
    const post = async (payload: unknown, headers?: Record<string, string>) =>
      testJson("/api/content/video-bookmarks", {
        method: "POST",
        headers: headers ?? (await authHeader()),
        body: JSON.stringify(payload),
      });

    it("returns 401 when unauthenticated", async () => {
      const { status } = await post({ videoId: 5, positionSeconds: 10 }, {});
      expect(status).toBe(401);
    });

    it("returns 400 when positionSeconds is negative", async () => {
      const { status } = await post({ videoId: 5, positionSeconds: -1 });
      expect(status).toBe(400);
    });

    it("returns 400 when the note is too long", async () => {
      const { status } = await post({ videoId: 5, positionSeconds: 1, note: "x".repeat(1001) });
      expect(status).toBe(400);
    });

    it("returns 404 when the video does not exist", async () => {
      mockEventVideoFindFirst.mockResolvedValueOnce(null);
      const { status } = await post({ videoId: 999, positionSeconds: 10 });
      expect(status).toBe(404);
    });

    it("returns 403 when the event is a draft for a regular user", async () => {
      mockEventVideoFindFirst.mockResolvedValueOnce(
        publicEventVideo({ event: { id: 42, status: "draft", audience: { slug: "free-anyone" } } }),
      );
      mockUserFindFirst.mockResolvedValueOnce(activeUser());
      const { status } = await post({ videoId: 5, positionSeconds: 10 });
      expect(status).toBe(403);
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it("returns 403 when the user may not access the event", async () => {
      mockEventVideoFindFirst.mockResolvedValueOnce(
        publicEventVideo({
          event: { id: 42, status: "published", audience: { slug: "retreat-group-members" } },
        }),
      );
      mockUserFindFirst.mockResolvedValueOnce({ ...activeUser(), subscriptionStatus: "none" });
      const { status } = await post({ videoId: 5, positionSeconds: 10 });
      expect([401, 403]).toContain(status);
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it("creates a bookmark and returns 201 with the joined row", async () => {
      mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
      mockUserFindFirst.mockResolvedValueOnce(activeUser());
      mockInsertReturning.mockResolvedValueOnce([{ id: 1 }]);
      mockBookmarkFindFirst.mockResolvedValueOnce(makeBookmark());

      const { status, body } = await post({ videoId: 5, positionSeconds: 754, note: "Key passage" });

      expect(status).toBe(201);
      expect(body.positionSeconds).toBe(754);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, videoId: 5, positionSeconds: 754, note: "Key passage" }),
      );
    });

    it("keeps the createdAt sent by the client", async () => {
      mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
      mockUserFindFirst.mockResolvedValueOnce(activeUser());
      mockInsertReturning.mockResolvedValueOnce([{ id: 1 }]);
      mockBookmarkFindFirst.mockResolvedValueOnce(makeBookmark());

      await post({ videoId: 5, positionSeconds: 3, createdAt: "2026-01-02T03:04:05.000Z" });

      const values = mockInsertValues.mock.calls[0]![0];
      expect(values.createdAt).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    });
  });

  describe("PATCH /api/content/video-bookmarks/:id", () => {
    const patch = async (payload: unknown, headers?: Record<string, string>) =>
      testJson("/api/content/video-bookmarks/1", {
        method: "PATCH",
        headers: headers ?? (await authHeader()),
        body: JSON.stringify(payload),
      });

    it("returns 401 when unauthenticated", async () => {
      const { status } = await patch({ note: "a" }, {});
      expect(status).toBe(401);
    });

    it("updates the note", async () => {
      mockUpdateReturning.mockResolvedValueOnce([{ id: 1, note: "new" }]);
      const { status, body } = await patch({ note: "new" });
      expect(status).toBe(200);
      expect(body.note).toBe("new");
    });

    it("returns 404 when the bookmark is not the user's", async () => {
      mockUpdateReturning.mockResolvedValueOnce([]);
      const { status } = await patch({ note: "new" });
      expect(status).toBe(404);
    });

    it("returns 400 when the note is missing", async () => {
      const { status } = await patch({});
      expect(status).toBe(400);
    });
  });

  describe("DELETE /api/content/video-bookmarks/:id", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/video-bookmarks/1", { method: "DELETE" });
      expect(status).toBe(401);
    });

    it("deletes the bookmark and returns it", async () => {
      mockDeleteReturning.mockResolvedValueOnce([{ id: 1, videoId: 5 }]);
      const { status, body } = await testJson("/api/content/video-bookmarks/1", {
        method: "DELETE",
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body.id).toBe(1);
    });

    it("returns 404 when the bookmark does not exist or is not the user's", async () => {
      mockDeleteReturning.mockResolvedValueOnce([]);
      const { status } = await testJson("/api/content/video-bookmarks/1", {
        method: "DELETE",
        headers: await authHeader(),
      });
      expect(status).toBe(404);
    });
  });
});
