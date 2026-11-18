import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";
import { EVENT_CLIENT_COLUMNS } from "../../src/lib/client-columns.ts";

// Main teachers vs guests / other speakers (André, backoffice): the app needs each
// teacher's role, the order the admin chose, and the event's guest intro phrase.

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

mockDb.select.mockReturnValue({ from: vi.fn(() => Promise.resolve([])) });

const teacher = (id: number, name: string) => ({
  id,
  name,
  abbreviation: name.slice(0, 3).toUpperCase(),
  photoUrl: null,
  avatarS3Key: null,
  heroS3Key: null,
  heroMobileS3Key: null,
  heroFocalX: 50,
  heroFocalY: 50,
  heroScale: 100,
  avatarUpdatedAt: null,
  heroUpdatedAt: null,
});

// Loaded in an order that is neither the role order nor the position order.
const links = [
  { eventId: 9, teacherId: 3, role: "guest", position: 2, teacher: teacher(3, "Shechen Rabjam Rinpoche") },
  { eventId: 9, teacherId: 2, role: "teacher", position: 1, teacher: teacher(2, "Pema Wangyal Rinpoche") },
  { eventId: 9, teacherId: 1, role: "teacher", position: 0, teacher: teacher(1, "Jigme Khyentse Rinpoche") },
];

const event = (over: Record<string, unknown> = {}) => ({
  id: 9,
  status: "published",
  titleEn: "Lembrun",
  audience: { slug: "free-anyone" },
  guestIntro: "with_presence_of",
  eventTeachers: links,
  eventRetreatGroups: [],
  videos: [],
  eventOrganizers: [],
  sessions: [],
  ...over,
});

describe("event teachers and guests in client payloads", () => {
  beforeEach(() => mockDb.query.events.findFirst.mockReset());

  it("should load guestIntro among the client event columns", () => {
    expect(EVENT_CLIENT_COLUMNS).toHaveProperty("guestIntro", true);
  });

  it("should return the main teachers first then the guests, each with its role, and the guest intro", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event());

    const { body } = await testJson("/api/events/featured");

    expect(body.guestIntro).toBe("with_presence_of");
    expect(body.eventTeachers.map((et: { teacher: { name: string }; role: string }) => [et.teacher.name, et.role])).toEqual([
      ["Jigme Khyentse Rinpoche", "teacher"],
      ["Pema Wangyal Rinpoche", "teacher"],
      ["Shechen Rabjam Rinpoche", "guest"],
    ]);
  });

  it("should give the locked-event preview the teachers in order with their role and the guest intro", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ audience: { slug: "free-subscribers" } }));

    const { body } = await testJson("/api/events/9/preview");

    expect(body.guestIntro).toBe("with_presence_of");
    expect(body.teachers).toEqual([
      { name: "Jigme Khyentse Rinpoche", role: "teacher" },
      { name: "Pema Wangyal Rinpoche", role: "teacher" },
      { name: "Shechen Rabjam Rinpoche", role: "guest" },
    ]);
  });
});
