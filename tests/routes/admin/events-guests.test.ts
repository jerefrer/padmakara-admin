import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, insertCalls, setCalls, deleteCalls } = vi.hoisted(() => {
  const insertCalls: unknown[] = [];
  const setCalls: Record<string, unknown>[] = [];
  const deleteCalls: unknown[] = [];
  const mockDb = {
    query: { events: { findFirst: vi.fn() } },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
    insert: vi.fn(() => ({
      values: vi.fn((data: unknown) => {
        insertCalls.push(data);
        return { returning: vi.fn(() => Promise.resolve([{ id: 5 }])) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        setCalls.push(data);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      deleteCalls.push(table);
      return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) };
    }),
  };
  return { mockDb, insertCalls, setCalls, deleteCalls };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { createAccessToken } from "../../../src/services/auth.ts";
import { eventTeachers } from "../../../src/db/schema/retreats.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  guestIntro: "with_presence_of",
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

const baseBody = { eventCode: "E5", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };

describe("admin events: main teachers, guests and guest intro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCalls.length = 0;
    setCalls.length = 0;
    deleteCalls.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should store the guest intro and number the teachers in the order sent when creating", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({
        ...baseBody,
        guestIntro: "with_presence_of",
        teacherIds: [
          { id: 7, role: "teacher" },
          { id: 3, role: "teacher" },
          { id: 9, role: "guest" },
        ],
      }),
    });

    expect(status).toBe(201);
    expect(insertCalls[0]).toMatchObject({ guestIntro: "with_presence_of" });
    expect(insertCalls).toContainEqual([
      { eventId: 5, teacherId: 7, role: "teacher", position: 0 },
      { eventId: 5, teacherId: 3, role: "teacher", position: 1 },
      { eventId: 5, teacherId: 9, role: "guest", position: 2 },
    ]);
  });

  it("should change only the guest intro on an update that sends only it", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ guestIntro: "practice_sessions_by" }),
    });

    expect(status).toBe(200);
    expect(setCalls[0]).toMatchObject({ guestIntro: "practice_sessions_by" });
    expect(deleteCalls).not.toContain(eventTeachers);
  });

  it("should keep the stored guest intro on an update that does not send it", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ titleEn: "Renamed" }),
    });

    expect(status).toBe(200);
    expect(setCalls[0]).not.toHaveProperty("guestIntro");
  });

  it("should clear the guest intro back to the default when null is sent", async () => {
    await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ guestIntro: null }),
    });

    expect(setCalls[0]).toMatchObject({ guestIntro: null });
  });

  it("should refuse an unknown guest intro", async () => {
    const { status } = await testJson("/api/admin/events/5", {
      method: "PUT",
      headers: await auth(),
      body: JSON.stringify({ guestIntro: "with friends" }),
    });

    expect(status).toBe(400);
  });
});
