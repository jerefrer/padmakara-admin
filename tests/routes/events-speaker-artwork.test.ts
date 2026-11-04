import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    query: { events: { findFirst: vi.fn(), findMany: vi.fn() } },
    select: vi.fn(),
  },
}));

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
}));

const teacherRow = (over: Record<string, unknown>) => ({
  aliases: [],
  heroS3Key: "teachers/x/hero.jpg",
  heroFocalX: 50,
  heroFocalY: 50,
  heroFrameOverrides: null,
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  ...over,
});

mockDb.select.mockReturnValue({
  from: vi.fn(() =>
    Promise.resolve([
      teacherRow({ id: 1, name: "Teacher One", abbreviation: "ONE" }),
      teacherRow({ id: 2, name: "Teacher Two", abbreviation: "TWO", heroS3Key: null }),
    ]),
  ),
});

const eventWith = (tracks: unknown[], teacher: Record<string, unknown> | null) => ({
  id: 1,
  eventTeachers: teacher ? [{ teacher }] : [],
  eventRetreatGroups: [],
  videos: [],
  eventOrganizers: [],
  sessions: [{ id: 1, tracks }],
});

describe("track speakerArtworkUrl in the event payload", () => {
  beforeEach(() => mockDb.query.events.findFirst.mockReset());

  it("should be the track speaker's artwork URL when the speaker has a hero image", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(eventWith([{ id: 1, speaker: "one" }], null));
    const { body } = await testJson("/api/events/featured");
    const track = body.sessions[0].tracks[0];
    expect(track.speakerName).toBe("Teacher One");
    expect(track.speakerArtworkUrl).toMatch(/\/api\/teachers\/1\/artwork\.jpg\?v=1767312000000$/);
  });

  it("should fall back to the event's first teacher when the track has no speaker", async () => {
    const eventTeacher = { id: 5, heroS3Key: "t/hero.jpg", heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0) };
    mockDb.query.events.findFirst.mockResolvedValueOnce(eventWith([{ id: 1, speaker: null }], eventTeacher));
    const { body } = await testJson("/api/events/featured");
    expect(body.sessions[0].tracks[0].speakerArtworkUrl).toMatch(/\/api\/teachers\/5\/artwork\.jpg\?v=0$/);
  });

  it("should fall back to the event's first teacher when the speaker has no hero image", async () => {
    const eventTeacher = { id: 5, heroS3Key: "t/hero.jpg", heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0) };
    mockDb.query.events.findFirst.mockResolvedValueOnce(eventWith([{ id: 1, speaker: "TWO" }], eventTeacher));
    const { body } = await testJson("/api/events/featured");
    expect(body.sessions[0].tracks[0].speakerArtworkUrl).toMatch(/\/teachers\/5\/artwork\.jpg/);
  });

  it("should be null when neither the speaker nor the event teacher has a hero image", async () => {
    const eventTeacher = { id: 6, heroS3Key: null, heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0) };
    mockDb.query.events.findFirst.mockResolvedValueOnce(eventWith([{ id: 1, speaker: "TWO" }], eventTeacher));
    const { body } = await testJson("/api/events/featured");
    expect(body.sessions[0].tracks[0].speakerArtworkUrl).toBeNull();
  });

  it("should fall back to the first event teacher who has a photo when the first teacher has none", async () => {
    const noPhoto = { id: 408, heroS3Key: null, heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0) };
    const withPhoto = { id: 407, heroS3Key: "t/hero.jpg", heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0) };
    const event = eventWith([{ id: 1, speaker: "TWO" }, { id: 2, speaker: null }], null);
    event.eventTeachers = [{ teacher: noPhoto }, { teacher: withPhoto }];
    mockDb.query.events.findFirst.mockResolvedValueOnce(event);
    const { body } = await testJson("/api/events/featured");
    for (const track of body.sessions[0].tracks) {
      expect(track.speakerArtworkUrl).toMatch(/\/api\/teachers\/407\/artwork\.jpg/);
    }
  });
});

describe("photoTeacherId in the event payload", () => {
  beforeEach(() => mockDb.query.events.findFirst.mockReset());

  const teacher = (id: number, name: string, heroS3Key: string | null, heroUrl: string | null) => ({
    id, name, abbreviation: name, heroS3Key, heroUrl, avatarUrl: null,
    heroFocalX: 50, heroFocalY: 50, updatedAt: new Date(0),
  });

  it("should name the first teacher with a hero image on the featured event, not the first teacher", async () => {
    const event = eventWith([], null);
    event.eventTeachers = [
      { teacher: teacher(408, "Dr. Loure Phuntsok", null, null) },
      { teacher: teacher(407, "Khenpo Namgyal Phuntsok", "t/h.jpg", null) },
    ];
    mockDb.query.events.findFirst.mockResolvedValueOnce(event);
    const { body } = await testJson("/api/events/featured");
    expect(body.photoTeacherId).toBe(407);
    expect(body.eventTeachers.find((et: any) => et.teacher.id === 407).teacher.heroUrl).toBeTruthy();
  });

  it("should be null when no teacher has a photo", async () => {
    const event = eventWith([], null);
    event.eventTeachers = [{ teacher: teacher(408, "Dr. Loure Phuntsok", null, null) }];
    mockDb.query.events.findFirst.mockResolvedValueOnce(event);
    const { body } = await testJson("/api/events/featured");
    expect(body.photoTeacherId).toBeNull();
  });
});
