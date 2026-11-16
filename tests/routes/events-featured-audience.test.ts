import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// GET /api/events/featured is public (optional auth) and feeds the home highlight for
// everyone. The featured event's CONTENT (sessions, tracks with their S3 keys,
// transcripts, videos, files, linked publications) must only reach callers its
// audience lets in; everyone else gets the event as an announcement, metadata only.
// The real access service runs here; only the database is mocked.

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    query: {
      events: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
      eventAccessGrants: { findFirst: vi.fn() },
    },
    // Speaker names (`select().from(teachers)`) and group lookups: none here.
    select: vi.fn(),
  },
}));

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
}));

import { createAccessToken } from "../../src/services/auth.ts";

function featuredEvent(audienceSlug: string) {
  return {
    id: 42,
    titleEn: "Spring Retreat",
    titlePt: null,
    status: "published",
    featuredAt: new Date().toISOString(),
    startDate: "2026-04-10",
    endDate: "2026-04-15",
    audienceId: 3,
    audience: { slug: audienceSlug },
    audioPublished: true,
    videoPublished: true,
    transcriptsPublished: true,
    textsPublished: true,
    topicsPublished: true,
    mainThemesEn: "Compassion",
    eventTeachers: [{ teacher: { id: 1, name: "Teacher One" } }],
    eventRetreatGroups: [],
    eventPlaces: [],
    eventOrganizers: [],
    eventPublications: [{ publication: { id: 3, title: "Text" } }],
    videos: [{ id: 5, bunnyVideoId: "guid", posterUrl: null }],
    transcripts: [{ id: 9, s3Key: "events/42/transcripts/t.pdf" }],
    eventFiles: [{ id: 7, s3Key: "events/42/files/f.pdf" }],
    sessions: [
      {
        id: 10,
        tracks: [{ id: 100, title: "Intro", s3Key: "events/42/001.mp3", readAlongS3Key: null }],
      },
    ],
  };
}

function userRow(subscriptionStatus: string) {
  return { id: 1, role: "user", subscriptionStatus, subscriptionExpiresAt: null };
}

async function userHeader() {
  const token = await createAccessToken({ sub: 1, email: "u@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

function expectAnnouncementOnly(body: any) {
  // The home card still has what it shows
  expect(body.id).toBe(42);
  expect(body.titleEn).toBe("Spring Retreat");
  expect(body.eventTeachers[0].teacher.name).toBe("Teacher One");
  // And none of the content
  expect(body.sessions).toEqual([]);
  expect(body.transcripts).toEqual([]);
  expect(body.videos).toEqual([]);
  expect(body.eventFiles).toEqual([]);
  expect(body.eventPublications).toEqual([]);
  expect(JSON.stringify(body)).not.toContain("s3Key");
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
});

describe("GET /api/events/featured — audience", () => {
  it("should return only the announcement to a guest when the featured event is not public", async () => {
    mockDb.query.events.findFirst.mockResolvedValue(featuredEvent("free-subscribers"));

    const { status, body } = await testJson("/api/events/featured");

    expect(status).toBe(200);
    expectAnnouncementOnly(body);
  });

  it("should return only the announcement to a signed-in user outside the featured event's audience", async () => {
    mockDb.query.events.findFirst.mockResolvedValue(featuredEvent("restricted"));
    mockDb.query.users.findFirst.mockResolvedValue(userRow("active"));

    const { status, body } = await testJson("/api/events/featured", { headers: await userHeader() });

    expect(status).toBe(200);
    expectAnnouncementOnly(body);
  });

  it("should return the content to a member the featured event's audience lets in", async () => {
    mockDb.query.events.findFirst.mockResolvedValue(featuredEvent("free-subscribers"));
    mockDb.query.users.findFirst.mockResolvedValue(userRow("active"));

    const { status, body } = await testJson("/api/events/featured", { headers: await userHeader() });

    expect(status).toBe(200);
    expect(body.sessions[0].tracks[0].id).toBe(100);
    expect(body.transcripts).toHaveLength(1);
  });

  it("should return the content of a public featured event to a guest", async () => {
    mockDb.query.events.findFirst.mockResolvedValue(featuredEvent("free-anyone"));

    const { status, body } = await testJson("/api/events/featured");

    expect(status).toBe(200);
    expect(body.sessions[0].tracks[0].id).toBe(100);
    expect(body.videos).toHaveLength(1);
  });
});
