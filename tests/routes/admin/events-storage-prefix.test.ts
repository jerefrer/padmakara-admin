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
  storagePrefix: "E5-OLD",
  status: "draft",
  featuredAt: null,
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

const base = { eventCode: "RP1", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };

describe("admin events: storagePrefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues.length = 0;
    updatedSets.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should store the event code as storage folder when the event is created", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify(base),
    });
    expect(status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ eventCode: "RP1", storagePrefix: "RP1" });
  });

  it("should ignore a storagePrefix sent on create", async () => {
    await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ ...base, storagePrefix: "ELSEWHERE" }),
    });
    expect(insertedValues[0]).toMatchObject({ storagePrefix: "RP1" });
  });

  it("should keep the storage folder when the event code is changed on PUT", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ eventCode: "RENAMED-BY-LIBRARY-IMPORT" }),
    });
    expect(status).toBe(200);
    expect(updatedSets[0]).toMatchObject({ eventCode: "RENAMED-BY-LIBRARY-IMPORT" });
    expect(updatedSets[0]).not.toHaveProperty("storagePrefix");
  });

  it("should ignore a storagePrefix sent on PUT", async () => {
    await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ titleEn: "New", storagePrefix: "ELSEWHERE" }),
    });
    expect(updatedSets[0]).not.toHaveProperty("storagePrefix");
  });
});
