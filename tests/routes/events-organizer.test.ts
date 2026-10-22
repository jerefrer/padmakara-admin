import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { query: { events: { findFirst: vi.fn(), findMany: vi.fn() } } },
}));

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
}));

describe("GET /api/events/featured organizer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should keep returning organizer as one comma-joined string in position order", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce({
      id: 1,
      eventTeachers: [],
      eventRetreatGroups: [],
      videos: [],
      sessions: [],
      eventOrganizers: [
        { position: 1, organizer: { id: 2, name: "Fundação Kangyur Rinpoche", abbreviation: null } },
        { position: 0, organizer: { id: 1, name: "Casa da Cultura do Tibete", abbreviation: null } },
      ],
    });
    const { status, body } = await testJson("/api/events/featured");
    expect(status).toBe(200);
    expect(body.organizer).toBe("Casa da Cultura do Tibete · Fundação Kangyur Rinpoche");
    expect(body).not.toHaveProperty("eventOrganizers");
  });

  it("should return organizer null when the event has no organizers", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce({
      id: 1, eventTeachers: [], eventRetreatGroups: [], videos: [], sessions: [], eventOrganizers: [],
    });
    const { body } = await testJson("/api/events/featured");
    expect(body.organizer).toBeNull();
  });
});
