import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, insertCalls, deleteCalls } = vi.hoisted(() => {
  const insertCalls: unknown[] = [];
  const deleteCalls: unknown[] = [];
  const mockDb = {
    query: {
      events: { findFirst: vi.fn() },
      organizers: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn((data: unknown) => {
        insertCalls.push(data);
        return { returning: vi.fn(() => Promise.resolve([{ id: 5 }])) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) })),
    })),
    delete: vi.fn((table: unknown) => {
      deleteCalls.push(table);
      return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5, name: "X" }])) })) };
    }),
  };
  return { mockDb, insertCalls, deleteCalls };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { createAccessToken } from "../../../src/services/auth.ts";
import { eventOrganizers } from "../../../src/db/schema/retreats.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [
    { position: 1, organizer: { id: 2, name: "Fundação Kangyur Rinpoche", abbreviation: "F. Kangyur Rinpoche" } },
    { position: 0, organizer: { id: 9, name: "Casa da Cultura do Tibete", abbreviation: null } },
  ],
};

const baseBody = { eventCode: "E5", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };

describe("admin events: organizers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCalls.length = 0;
    deleteCalls.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should link organizers in the order sent when creating an event", async () => {
    const { status, body } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...baseBody, organizerIds: [9, 2] }),
    });
    expect(status).toBe(201);
    expect(insertCalls).toContainEqual([
      { eventId: 5, organizerId: 9, position: 0 },
      { eventId: 5, organizerId: 2, position: 1 },
    ]);
    expect(body.organizer).toBe("Casa da Cultura do Tibete · Fundação Kangyur Rinpoche");
    expect(body.organizers.map((o: { id: number }) => o.id)).toEqual([9, 2]);
    expect(body).not.toHaveProperty("eventOrganizers");
  });

  it("should create an event with no organizer link when none is chosen", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify(baseBody),
    });
    expect(status).toBe(201);
    expect(insertCalls.some((v) => Array.isArray(v) && (v[0] as { organizerId?: number })?.organizerId)).toBe(false);
  });

  it("should replace the organizer links when updating with organizerIds", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ organizerIds: [2, 2, 9] }),
    });
    expect(status).toBe(200);
    expect(deleteCalls).toContain(eventOrganizers);
    // A repeated id is dropped; the first occurrence keeps its slot.
    expect(insertCalls).toContainEqual([
      { eventId: 5, organizerId: 2, position: 0 },
      { eventId: 5, organizerId: 9, position: 1 },
    ]);
  });

  it("should leave organizer links alone when an update does not send organizerIds", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ titleEn: "Renamed" }),
    });
    expect(status).toBe(200);
    expect(deleteCalls).not.toContain(eventOrganizers);
  });

  it("should return the organizer string and entities on the event detail", async () => {
    const { status, body } = await testJson("/api/admin/events/5", { headers: await auth() });
    expect(status).toBe(200);
    expect(body.organizer).toBe("Casa da Cultura do Tibete · Fundação Kangyur Rinpoche");
    expect(body.organizers[1]).toEqual({ id: 2, name: "Fundação Kangyur Rinpoche", abbreviation: "F. Kangyur Rinpoche" });
  });
});
