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

async function userHeader() {
  const token = await createAccessToken({ sub: 1, email: "u@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
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
  it("should return the content of a public featured event to a guest", async () => {
    mockDb.query.events.findFirst.mockResolvedValue(featuredEvent("free-anyone"));

    const { status, body } = await testJson("/api/events/featured");

    expect(status).toBe(200);
    expect(body.sessions[0].tracks[0].id).toBe(100);
    expect(body.videos).toHaveLength(1);
  });

  it("should never return a featured event that is not free for everyone, and fall back to a free one", async () => {
    const legacy = { ...featuredEvent("free-subscribers"), id: 42 };
    const stand = { ...featuredEvent("free-anyone"), id: 77 };
    mockDb.query.events.findFirst.mockResolvedValueOnce(legacy).mockResolvedValueOnce(stand);

    const { status, body } = await testJson("/api/events/featured");

    expect(status).toBe(200);
    expect(body.id).toBe(77);
  });

  it("should return null rather than a non-free event when no free event exists", async () => {
    mockDb.query.events.findFirst
      .mockResolvedValueOnce(featuredEvent("restricted"))
      .mockResolvedValueOnce(undefined);

    const { status, body } = await testJson("/api/events/featured", { headers: await userHeader() });

    expect(status).toBe(200);
    expect(body).toBeNull();
  });
});
