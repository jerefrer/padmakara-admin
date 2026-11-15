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
  generatePresignedDownloadUrl: vi.fn((key: string) => Promise.resolve(`https://signed/${key}`)),
}));

mockDb.select.mockReturnValue({
  from: vi.fn(() =>
    Promise.resolve([
      { id: 1, name: "Teacher One", abbreviation: "ONE", aliases: [], heroS3Key: "t/hero.jpg", heroFocalX: 50, heroFocalY: 50, heroFrameOverrides: null, updatedAt: new Date(0) },
    ]),
  ),
});

const photo = {
  avatarS3Key: "events/E/images/avatar.webp",
  heroS3Key: "events/E/images/hero.webp",
  heroMobileS3Key: "events/E/images/hero-m.webp",
  heroOriginalS3Key: "events/E/images/originals/o.jpg",
  heroCrop: { x: 0, y: 0, width: 1, height: 1 },
  heroFocalX: 20,
  heroFocalY: 70,
  heroScale: 100,
  heroGrayscale: false,
  heroFrameOverrides: null,
  avatarUpdatedAt: new Date("2026-02-01T00:00:00Z"),
  heroUpdatedAt: new Date("2026-02-02T00:00:00Z"),
};

const event = (over: Record<string, unknown> = {}) => ({
  id: 9,
  status: "published",
  eventTeachers: [],
  eventRetreatGroups: [],
  videos: [],
  eventOrganizers: [],
  sessions: [{ id: 1, tracks: [{ id: 1, speaker: "one" }] }],
  ...over,
});

describe("event photo in the event payload", () => {
  beforeEach(() => mockDb.query.events.findFirst.mockReset());

  it("should expose an image object with resolved URLs and framing when the event has a photo", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event(photo));
    const { body } = await testJson("/api/events/featured");
    expect(body.image).toMatchObject({
      avatarUrl: "https://signed/events/E/images/avatar.webp",
      heroUrl: "https://signed/events/E/images/hero.webp",
      heroMobileUrl: "https://signed/events/E/images/hero-m.webp",
      heroFocalX: 20,
      heroFocalY: 70,
      heroFrameOverrides: null,
      heroUpdatedAt: "2026-02-02T00:00:00.000Z",
    });
  });

  it("should not leak S3 keys or the re-edit state", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event(photo));
    const { body } = await testJson("/api/events/featured");
    for (const key of ["heroS3Key", "avatarS3Key", "heroMobileS3Key", "heroOriginalS3Key", "heroCrop", "heroGrayscale"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("should have a null image when the event has no photo", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ heroS3Key: null, avatarS3Key: null, heroMobileS3Key: null }));
    const { body } = await testJson("/api/events/featured");
    expect(body.image).toBeNull();
  });

  it("should point the lock-screen artwork of every track at the event photo", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event(photo));
    const { body } = await testJson("/api/events/featured");
    expect(body.sessions[0].tracks[0].speakerArtworkUrl).toMatch(/\/api\/events\/9\/artwork\.jpg\?v=1769990400000$/);
    expect(body.image.artworkUrl).toBe(body.sessions[0].tracks[0].speakerArtworkUrl);
  });

  it("should keep the speaker's artwork when the event has no photo", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ heroS3Key: null }));
    const { body } = await testJson("/api/events/featured");
    expect(body.sessions[0].tracks[0].speakerArtworkUrl).toMatch(/\/api\/teachers\/1\/artwork\.jpg/);
  });

  it("should keep photoTeacherId as the teacher choice even with an event photo", async () => {
    const teacher = { id: 1, heroS3Key: "t/hero.jpg", avatarS3Key: null, heroMobileS3Key: null, heroFocalX: 50, heroFocalY: 50, name: "T", abbreviation: "T", updatedAt: new Date(0) };
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ ...photo, eventTeachers: [{ teacher }] }));
    const { body } = await testJson("/api/events/featured");
    expect(body.photoTeacherId).toBe(1);
  });
});
