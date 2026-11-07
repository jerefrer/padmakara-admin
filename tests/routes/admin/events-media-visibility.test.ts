import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, insertedValues, updatedSets, mockBumpVersion } = vi.hoisted(() => {
  const insertedValues: Record<string, unknown>[] = [];
  const updatedSets: Record<string, unknown>[] = [];
  const mockBumpVersion = vi.fn(() => Promise.resolve());
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
  return { mockDb, insertedValues, updatedSets, mockBumpVersion };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: mockBumpVersion }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  status: "published",
  featuredAt: null,
  audioPublished: true,
  videoPublished: true,
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

const base = { eventCode: "RP1", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };

describe("admin events: audioPublished / videoPublished", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    updatedSets.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should store the flags on create", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...base, audioPublished: true, videoPublished: false }),
    });
    expect(status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ audioPublished: true, videoPublished: false });
  });

  it("should leave the flags to the column default on create when omitted", async () => {
    await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify(base),
    });
    expect(insertedValues[0]).not.toHaveProperty("audioPublished");
    expect(insertedValues[0]).not.toHaveProperty("videoPublished");
  });

  it("should update only the flag that was sent on PUT and bump the events sync version", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ videoPublished: false }),
    });
    expect(status).toBe(200);
    expect(updatedSets[0]).toMatchObject({ videoPublished: false });
    expect(updatedSets[0]).not.toHaveProperty("audioPublished");
    expect(mockBumpVersion).toHaveBeenCalledWith("events");
  });

  it("should reject a non-boolean flag", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ audioPublished: "no" }),
    });
    expect(status).toBe(400);
  });
});
