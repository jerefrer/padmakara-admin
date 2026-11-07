import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, insertedValues, updatedSets } = vi.hoisted(() => {
  const insertedValues: Record<string, unknown>[] = [];
  const updatedSets: Record<string, unknown>[] = [];
  const mockDb = {
    query: { events: { findFirst: vi.fn() } },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        updatedSets.push(data);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((data: Record<string, unknown>) => {
        insertedValues.push(data);
        return { returning: vi.fn(() => Promise.resolve([{ id: 5, ...data }])) };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
  };
  return { mockDb, insertedValues, updatedSets };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  eventCodeReviewed: false,
  status: "draft",
  featuredAt: null,
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

const base = { eventCode: "RP1", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };

describe("admin events: eventCodeReviewed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    updatedSets.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should store false on create when the code was auto-generated", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...base, eventCodeReviewed: false }),
    });
    expect(status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ eventCode: "RP1", eventCodeReviewed: false });
  });

  it("should leave the flag to the column default on create when it is omitted", async () => {
    await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify(base),
    });
    expect(insertedValues[0]).not.toHaveProperty("eventCodeReviewed");
  });

  it("should set the flag to true on PUT", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ eventCodeReviewed: true }),
    });
    expect(status).toBe(200);
    expect(updatedSets[0]).toMatchObject({ eventCodeReviewed: true });
  });

  it("should not touch the flag on PUT when it is omitted", async () => {
    await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ titleEn: "New" }),
    });
    expect(updatedSets[0]).not.toHaveProperty("eventCodeReviewed");
  });
});
