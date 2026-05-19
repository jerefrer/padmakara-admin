import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
// mockEventFindFirst is the lookup used by the draft-status guard in
// POST /event-bookmarks. It must be separate from mockFindFirst so each
// test can stage exactly the mocks the handler will consume in order.
const mockEventFindFirst = vi.fn();
const mockInsertReturning = vi.fn();
const mockDeleteReturning = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: {
        // Used by the draft-status guard in POST /event-bookmarks.
        findFirst: (...args: any[]) => mockEventFindFirst(...args),
      },
      eventBookmarks: {
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

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    eventCode: "2024.04.15-GROUP-PLACE-TEACHER",
    titleEn: "Spring Retreat 2024",
    titlePt: null,
    startDate: "2024-04-15",
    endDate: "2024-04-20",
    status: "published",
    eventTeachers: [],
    eventRetreatGroups: [],
    eventPlaces: [],
    audience: null,
    eventType: null,
    ...overrides,
  };
}

function makeBookmark(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 1,
    eventId: 42,
    createdAt: new Date("2026-05-01T12:00:00Z"),
    event: makeEvent(),
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

describe("Event bookmarks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/content/event-bookmarks", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/event-bookmarks");
      expect(status).toBe(401);
    });

    it("returns the user's bookmarked events", async () => {
      mockFindMany.mockResolvedValueOnce([makeBookmark(), makeBookmark({ id: 2, eventId: 43, event: makeEvent({ id: 43 }) })]);

      const { status, body } = await testJson("/api/content/event-bookmarks", {
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].eventId).toBe(42);
      expect(body[0].event.titleEn).toBe("Spring Retreat 2024");
    });

    it("returns empty array when user has no bookmarks", async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const { status, body } = await testJson("/api/content/event-bookmarks", {
        headers: await authHeader(),
      });
      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe("POST /api/content/event-bookmarks", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/event-bookmarks", {
        method: "POST",
        body: JSON.stringify({ eventId: 42 }),
      });
      expect(status).toBe(401);
    });

    it("returns 400 for invalid body", async () => {
      const { status } = await testJson("/api/content/event-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
    });

    it("creates a new bookmark and returns 201", async () => {
      // The draft-status guard calls db.query.events.findFirst first — return
      // a published event so the guard passes, then the insert + read-back fires.
      mockEventFindFirst.mockResolvedValueOnce({ id: 42, status: "published" });
      mockInsertReturning.mockResolvedValueOnce([{ id: 1, userId: 1, eventId: 42, createdAt: new Date() }]);
      mockFindFirst.mockResolvedValueOnce(makeBookmark());

      const { status, body } = await testJson("/api/content/event-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ eventId: 42 }),
      });

      expect(status).toBe(201);
      expect(body.eventId).toBe(42);
      expect(body.event.titleEn).toBe("Spring Retreat 2024");
    });

    it("is idempotent: returns existing bookmark with 200 when already bookmarked", async () => {
      // Guard passes (published event), then onConflictDoNothing → no row from insert.
      mockEventFindFirst.mockResolvedValueOnce({ id: 42, status: "published" });
      // onConflictDoNothing → no row returned from insert
      mockInsertReturning.mockResolvedValueOnce([]);
      mockFindFirst.mockResolvedValueOnce(makeBookmark());

      const { status, body } = await testJson("/api/content/event-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ eventId: 42 }),
      });

      expect(status).toBe(200);
      expect(body.eventId).toBe(42);
    });

    it("returns 404 when event does not exist", async () => {
      // Guard fires first: null from events.findFirst → 404 immediately.
      mockEventFindFirst.mockResolvedValueOnce(null);

      const { status } = await testJson("/api/content/event-bookmarks", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ eventId: 9999 }),
      });

      expect(status).toBe(404);
    });
  });

  describe("DELETE /api/content/event-bookmarks/:eventId", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await testJson("/api/content/event-bookmarks/42", {
        method: "DELETE",
      });
      expect(status).toBe(401);
    });

    it("deletes a bookmark and returns the deleted row", async () => {
      mockDeleteReturning.mockResolvedValueOnce([
        { id: 1, userId: 1, eventId: 42, createdAt: new Date() },
      ]);

      const { status, body } = await testJson("/api/content/event-bookmarks/42", {
        method: "DELETE",
        headers: await authHeader(),
      });

      expect(status).toBe(200);
      expect(body.eventId).toBe(42);
    });

    it("returns 404 when no bookmark exists for that event", async () => {
      mockDeleteReturning.mockResolvedValueOnce([]);

      const { status } = await testJson("/api/content/event-bookmarks/42", {
        method: "DELETE",
        headers: await authHeader(),
      });

      expect(status).toBe(404);
    });
  });
});
