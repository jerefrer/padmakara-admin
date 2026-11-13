import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { testJson } from "../helpers.ts";

// A "forthcoming" event is announced in the app, to the people who will have access,
// with none of its content. These tests pin both halves: it shows up in lists and in
// the event detail (metadata only), and every route that serves content treats it
// exactly like a draft for non-admins.

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    query: {
      events: { findFirst: vi.fn(), findMany: vi.fn() },
      audiences: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn(), findMany: vi.fn() },
      eventAccessGrants: { findFirst: vi.fn(), findMany: vi.fn() },
      sessions: { findFirst: vi.fn() },
      tracks: { findFirst: vi.fn() },
      retreatGroups: { findFirst: vi.fn() },
      downloadRequests: { findFirst: vi.fn() },
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
  openablePublications: vi.fn(() => Promise.resolve(new Set<number>([3]))),
}));
vi.mock("../../src/services/event-publications.ts", () => ({
  publicationsViaGroups: vi.fn(() => Promise.resolve([{ id: 3, title: "Via group", coverImageS3Key: null }])),
  mergePublications: vi.fn((a: unknown[], b: unknown[]) => [...a, ...b]),
}));
vi.mock("../../src/lib/group-utils.ts", () => ({
  resolveGroupsUrls: vi.fn((groups: unknown) => Promise.resolve(groups)),
  resolveEventsGroupUrls: vi.fn(() => Promise.resolve()),
  resolveEventGroupUrls: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../src/services/auth.ts";

const dialect = new PgDialect();

/** The values bound in a drizzle WHERE clause (the statuses, ids...). */
function whereParams(call: unknown): unknown[] {
  const arg = call as { where?: SQL } | undefined;
  return arg?.where ? dialect.sqlToQuery(arg.where).params : [];
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "forthcoming",
    audience: { slug: "free-subscribers" },
    audienceId: 2,
    audioPublished: true,
    videoPublished: true,
    transcriptsPublished: true,
    textsPublished: true,
    topicsPublished: true,
    titleEn: "Coming soon",
    titlePt: null,
    mainThemesEn: "Secret themes",
    mainThemesPt: null,
    sessionThemesEn: "Secret session themes",
    sessionThemesPt: null,
    startDate: "2026-12-01",
    endDate: "2026-12-05",
    eventTeachers: [],
    eventRetreatGroups: [{ retreatGroupId: 4, retreatGroup: { id: 4 } }],
    eventPlaces: [],
    eventOrganizers: [],
    eventPublications: [{ publication: { id: 3, title: "Pub", subtitle: null, coverImageS3Key: null } }],
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
    videos: [{ id: 5, bunnyVideoId: "abc" }],
    ...overrides,
  };
}

async function auth(role = "user") {
  const token = await createAccessToken({ sub: 1, email: "t@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

function userRow(role = "user", subscriptionStatus = "active") {
  return {
    id: 1,
    email: "t@test.com",
    role,
    subscriptionStatus,
    subscriptionExpiresAt: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.select.mockImplementation(() => ({
    from: vi.fn(() =>
      Object.assign(Promise.resolve<unknown[]>([]), {
        where: vi.fn(() => Promise.resolve([])),
      }),
    ),
  }));
  mockDb.query.userGroupMemberships.findMany.mockResolvedValue([]);
  mockDb.query.eventAccessGrants.findMany.mockResolvedValue([]);
});

describe("GET /api/events/:id for a forthcoming event", () => {
  it("should return metadata with empty content when the user has access", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { status, body } = await testJson("/api/events/1", { headers: await auth() });

    expect(status).toBe(200);
    expect(body.status).toBe("forthcoming");
    expect(body.titleEn).toBe("Coming soon");
    expect(body.startDate).toBe("2026-12-01");
    expect(body.sessions).toEqual([]);
    expect(body.videos).toEqual([]);
    expect(body.transcripts).toEqual([]);
    expect(body.eventFiles).toEqual([]);
    expect(body.eventPublications).toEqual([]);
    expect(body.relatedPublications).toEqual([]);
    expect(body.mainThemesEn).toBeNull();
    expect(body.sessionThemesEn).toBeNull();
  });

  it("should answer 403 when the user has no access to the audience", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user", "none"));

    const { status } = await testJson("/api/events/1", { headers: await auth() });

    expect(status).toBe(403);
  });

  it("should still answer 404 for a draft", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent({ status: "draft" }));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { status } = await testJson("/api/events/1", { headers: await auth() });

    expect(status).toBe(404);
  });

  it("should give an admin the full content", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("admin"));

    const { body } = await testJson("/api/events/1", { headers: await auth("admin") });

    expect(body.sessions).toHaveLength(1);
    expect(body.transcripts).toHaveLength(1);
    expect(body.mainThemesEn).toBe("Secret themes");
  });
});

describe("GET /api/events (list)", () => {
  it("should ask for forthcoming events and list the ones the user has access to", async () => {
    const open = makeEvent({ id: 1 });
    const locked = makeEvent({ id: 2, audience: { slug: "event-participants" } });
    mockDb.query.events.findMany.mockResolvedValueOnce([open, locked]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/events", { headers: await auth() });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body.map((e: { id: number }) => e.id)).toEqual([1]);
    expect(body[0].status).toBe("forthcoming");
    expect(body[0].sessions).toEqual([]);
    expect(body[0].mainThemesEn).toBeNull();
  });

  it("should not list a forthcoming event the user has no access to", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent()]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow("user", "none"));

    const { body } = await testJson("/api/events", { headers: await auth() });

    expect(body).toEqual([]);
  });

  it("should list forthcoming events for an admin, with their content", async () => {
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent()]);

    const { body } = await testJson("/api/events", { headers: await auth("admin") });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body).toHaveLength(1);
  });
});

describe("public events", () => {
  it("should ask for published events only on /public", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 1 });
    mockDb.query.events.findMany.mockResolvedValueOnce([]);

    await testJson("/api/events/public");

    const params = whereParams(mockDb.query.events.findMany.mock.calls[0]![0]);
    expect(params).toContain("published");
    expect(params).not.toContain("forthcoming");
  });

  it("should ask for published events only on /public/:id", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/events/public/1");

    const params = whereParams(mockDb.query.events.findFirst.mock.calls[0]![0]);
    expect(status).toBe(404);
    expect(params).not.toContain("forthcoming");
  });

  it("should ask for published events only on /featured", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(null);

    await testJson("/api/events/featured");

    expect(whereParams(mockDb.query.events.findFirst.mock.calls[0]![0])).not.toContain("forthcoming");
  });

  it("should answer 404 on the preview of a forthcoming event", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/events/1/preview");

    expect(status).toBe(404);
    expect(whereParams(mockDb.query.events.findFirst.mock.calls[0]![0])).not.toContain("forthcoming");
  });
});

describe("content routes deny a forthcoming event like a draft", () => {
  it("should answer 404 on a session of a forthcoming event", async () => {
    mockDb.query.sessions.findFirst.mockResolvedValueOnce({
      id: 10,
      tracks: [],
      event: makeEvent({ audience: { slug: "free-anyone" } }),
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { status } = await testJson("/api/events/sessions/10", { headers: await auth() });

    expect(status).toBe(404);
  });

  it("should answer 404 on a track of a forthcoming event", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      s3Key: "x.mp3",
      session: { event: makeEvent({ audience: { slug: "free-anyone" } }) },
    });
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { status } = await testJson("/api/events/tracks/100", { headers: await auth() });

    expect(status).toBe(404);
  });

  it("should answer 404 on the ZIP request of a forthcoming event", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent({ audience: { slug: "free-anyone" } }));
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { status } = await testJson("/api/events/1/request-download", {
      method: "POST",
      headers: await auth(),
    });

    expect(status).toBe(404);
  });

  it("should answer 404 on the audio URL of a forthcoming track, even with a grant", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValue({
      id: 100,
      s3Key: "x.mp3",
      session: { event: makeEvent({ audience: { slug: "everyone-paid" } }) },
    });
    mockDb.query.eventAccessGrants.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.users.findFirst.mockResolvedValue(userRow());

    const { status } = await testJson("/api/media/audio/100", { headers: await auth() });

    expect(status).toBe(404);
  });

  it("should answer 404 when recording progress on a forthcoming track", async () => {
    mockDb.query.tracks.findFirst.mockResolvedValueOnce({
      id: 100,
      session: { event: makeEvent() },
    });

    const { status } = await testJson("/api/content/progress", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ trackId: 100, positionSeconds: 5, durationSeconds: 60 }),
    });

    expect(status).toBe(404);
  });

  it("should answer 404 when bookmarking a forthcoming event", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(makeEvent());

    const { status } = await testJson("/api/content/event-bookmarks", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ eventId: 1 }),
    });

    expect(status).toBe(404);
  });
});

describe("groups", () => {
  it("should ask for forthcoming events on a group page and strip their content", async () => {
    mockDb.query.retreatGroups.findFirst.mockResolvedValueOnce({ id: 4 });
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([{ eventId: 1 }])) })),
    });
    mockDb.query.events.findMany.mockResolvedValueOnce([makeEvent()]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/groups/4/events", { headers: await auth() });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("forthcoming");
    expect(body[0].sessions).toEqual([]);
  });

  it("should derive the group list from forthcoming events too", async () => {
    const event = makeEvent({
      audience: { slug: "free-subscribers" },
      eventRetreatGroups: [{ retreatGroup: { id: 4, displayOrder: 1 } }],
    });
    mockDb.query.events.findMany.mockResolvedValueOnce([event]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/groups", { headers: await auth() });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body.map((g: { id: number }) => g.id)).toEqual([4]);
  });
});

describe("GET /api/teachings/mine", () => {
  it("should list a forthcoming event the audience opens, with no content", async () => {
    const event = makeEvent({ audience: { slug: "free-subscribers" }, eventRetreatGroups: [] });
    mockDb.query.events.findMany
      .mockResolvedValueOnce([event]) // candidates
      .mockResolvedValueOnce([event]); // rows
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/teachings/mine", { headers: await auth() });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("forthcoming");
    expect(body[0].sessions).toEqual([]);
  });
});

describe("search", () => {
  it("should find a forthcoming event by title but return no sessions or tracks", async () => {
    const event = makeEvent({
      audience: { slug: "free-anyone" },
      titleEn: "Bodhicitta retreat",
      sessions: [
        {
          id: 10,
          titleEn: "S",
          titlePt: null,
          sessionDate: null,
          timePeriod: null,
          sessionNumber: 1,
          tracks: [{ id: 100, title: "Bodhicitta talk" }],
        },
      ],
    });
    mockDb.query.events.findMany.mockResolvedValueOnce([event]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/search?q=bodhicitta", { headers: await auth() });

    expect(whereParams(mockDb.query.events.findMany.mock.calls[0]![0])).toContain("forthcoming");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].sessions).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Bodhicitta talk");
  });

  it("should not match on the hidden themes of a forthcoming event", async () => {
    const event = makeEvent({ audience: { slug: "free-anyone" }, titleEn: "Other" });
    mockDb.query.events.findMany.mockResolvedValueOnce([event]);
    mockDb.query.users.findFirst.mockResolvedValueOnce(userRow());

    const { body } = await testJson("/api/search?q=secret", { headers: await auth() });

    expect(body.results).toEqual([]);
  });
});
