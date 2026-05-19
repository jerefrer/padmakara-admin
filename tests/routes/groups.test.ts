import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// vi.hoisted ensures these variables are available when vi.mock factories run
// (vi.mock calls are hoisted to the top of the file before variable declarations)
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    query: {
      retreatGroups: {
        findFirst: vi.fn(),
      },
      events: {
        findMany: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
      userEventAttendance: {
        findFirst: vi.fn(),
      },
      userGroupMemberships: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
  return { mockDb };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));

// Mock teacher/group URL resolvers to be no-ops (they call S3/DB and aren't under test)
vi.mock("../../src/lib/teacher-utils.ts", () => ({
  resolveEventsTeacherUrls: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/group-utils.ts", () => ({
  resolveGroupsUrls: vi.fn((groups: unknown) => Promise.resolve(groups)),
  resolveEventsGroupUrls: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../src/services/auth.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const GROUP_ID = 5;

const mockGroup = {
  id: GROUP_ID,
  name: "Test Group",
  abbreviation: "TG",
  slug: "test-group",
  displayOrder: 1,
};

const DRAFT_EVENT_ID = 101;
const PUBLISHED_EVENT_ID = 102;

/** Minimal event row as returned by db.query.events.findMany in the route */
function makeMockEvent(id: number, status: "draft" | "published") {
  return {
    id,
    status,
    audience: { slug: "free-anyone" },
    sessions: [],
    eventTeachers: [],
    eventPlaces: [],
    eventRetreatGroups: [],
  };
}

/** Full user row returned by db.query.users.findFirst inside getFullUser */
function makeUserRow(role: string) {
  return {
    id: 1,
    email: "test@test.com",
    role,
    subscriptionStatus: "none",
    subscriptionExpiresAt: null,
  };
}

async function bearerToken(role: string) {
  const token = await createAccessToken({ sub: 1, email: "test@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

/**
 * Set up the common mock sequence for GET /api/groups/:id/events:
 *   1. retreatGroups.findFirst   → the group
 *   2. select().from().where()   → event links
 *   3. events.findMany           → event rows
 *   4. users.findFirst           → full user (for getFullUser)
 *
 * filterAccessibleEvents runs checkEventAccess per event. For "free-anyone"
 * audience, it returns { allowed: true } immediately without hitting the DB.
 */
function setupGroupEventMocks(events: ReturnType<typeof makeMockEvent>[]) {
  mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce(mockGroup);

  // The route uses db.select().from().where() for the eventRetreatGroups link lookup.
  // We return one link per event id.
  // as any: mockReturnValueOnce is typed from the base vi.fn() which infers never[] for
  // the empty array initial return; the concrete shape { eventId: number }[] is correct.
  mockDb.select.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() =>
        Promise.resolve(events.map((e) => ({ eventId: e.id }))),
      ),
    })),
  } as any);

  mockDb.query.events.findMany.mockResolvedValueOnce(events);
  mockDb.query.users.findFirst.mockResolvedValueOnce(makeUserRow("user")); // overridden per test via mockResolvedValueOnce ordering
}

// ─── Draft visibility on GET /api/groups/:id/events ──────────────────────────

const dialect = new PgDialect();

describe("GET /api/groups/:id/events — draft visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes draft events for an admin", async () => {
    // Arrange: group + links + both events; admin caller
    const allEvents = [
      makeMockEvent(DRAFT_EVENT_ID, "draft"),
      makeMockEvent(PUBLISHED_EVENT_ID, "published"),
    ];

    mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce(mockGroup);
    // as any: mockReturnValueOnce is typed from the base vi.fn() which infers never[] for
    // the empty array initial return; the concrete shape { eventId: number }[] is correct.
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Promise.resolve(allEvents.map((e) => ({ eventId: e.id }))),
        ),
      })),
    } as any);
    mockDb.query.events.findMany.mockResolvedValueOnce(allEvents);
    // getFullUser calls db.query.users.findFirst; return an admin row
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUserRow("admin"));

    // Act
    const { status, body } = await testJson(`/api/groups/${GROUP_ID}/events`, {
      headers: await bearerToken("admin"),
    });

    // Assert: HTTP 200 and draft event is present
    expect(status).toBe(200);
    const ids = (body as Array<{ id: number }>).map((e) => e.id);
    expect(ids).toContain(DRAFT_EVENT_ID);
    expect(ids).toContain(PUBLISHED_EVENT_ID);

    // Assert: the WHERE clause passed to findMany includes "draft" in its params.
    // This is the meaningful guard — the mock doesn't enforce WHERE but we can
    // inspect the Drizzle SQL node that was actually passed.
    expect(mockDb.query.events.findMany).toHaveBeenCalledTimes(1);
    // Safe: toHaveBeenCalledTimes(1) above guarantees calls[0] exists.
    // The cast to { where?: unknown } is required because mock.calls is untyped at
    // the call-arg level — Drizzle's SQL node type isn't reflected in vi mock types.
    const adminCallArg = mockDb.query.events.findMany.mock.calls[0]![0] as {
      where?: unknown;
    };
    // Render to SQL so we can inspect it as a plain string without circular-ref issues.
    const adminRendered = dialect.sqlToQuery(adminCallArg?.where as SQL);
    // Admin path must include "draft" in the status filter
    expect(adminRendered.params).toContain("draft");
    expect(adminRendered.params).toContain("published");
    // Must use inArray (not a bare eq), so the SQL contains "in"
    expect(adminRendered.sql).toMatch(/\bin\b/i);
  });

  it("excludes draft events for a regular user", async () => {
    // Arrange: same events; regular user caller
    const allEvents = [
      makeMockEvent(DRAFT_EVENT_ID, "draft"),
      makeMockEvent(PUBLISHED_EVENT_ID, "published"),
    ];

    mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce(mockGroup);
    // as any: mockReturnValueOnce is typed from the base vi.fn() which infers never[] for
    // the empty array initial return; the concrete shape { eventId: number }[] is correct.
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Promise.resolve(allEvents.map((e) => ({ eventId: e.id }))),
        ),
      })),
    } as any);
    // The DB mock doesn't enforce WHERE — return only the published event to
    // simulate what a real DB would do with a published-only filter.
    mockDb.query.events.findMany.mockResolvedValueOnce([
      makeMockEvent(PUBLISHED_EVENT_ID, "published"),
    ]);
    // getFullUser calls db.query.users.findFirst; return a regular-user row
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUserRow("user"));

    // Act
    const { status, body } = await testJson(`/api/groups/${GROUP_ID}/events`, {
      headers: await bearerToken("user"),
    });

    // Assert: HTTP 200 and draft event is absent
    expect(status).toBe(200);
    const ids = (body as Array<{ id: number }>).map((e) => e.id);
    expect(ids).not.toContain(DRAFT_EVENT_ID);
    expect(ids).toContain(PUBLISHED_EVENT_ID);

    // Assert: the WHERE clause does NOT include "draft" in its params.
    // This is the key guard for the regular-user path — the SQL filter must be
    // published-only, so even without DB enforcement the contract is verified.
    expect(mockDb.query.events.findMany).toHaveBeenCalledTimes(1);
    // Safe: toHaveBeenCalledTimes(1) above guarantees calls[0] exists.
    // The cast to { where?: unknown } is required because mock.calls is untyped.
    const userCallArg = mockDb.query.events.findMany.mock.calls[0]![0] as {
      where?: unknown;
    };
    const userRendered = dialect.sqlToQuery(userCallArg?.where as SQL);
    // Regular-user path must NOT include "draft" in the status filter
    expect(userRendered.params).not.toContain("draft");
    expect(userRendered.params).toContain("published");
  });
});
