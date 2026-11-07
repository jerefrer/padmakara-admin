import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, inserted, upsertSets, deleteCalls, noteRows, bumpVersion } = vi.hoisted(() => {
  const inserted: Record<string, unknown>[] = [];
  const upsertSets: Record<string, unknown>[] = [];
  const deleteCalls: unknown[] = [];
  const noteRows: { notes: string }[] = [];
  const bumpVersion = vi.fn(() => Promise.resolve());
  const mockDb = {
    query: { events: { findFirst: vi.fn() } },
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(noteRows)) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((data: Record<string, unknown>) => {
        inserted.push(data);
        return {
          onConflictDoUpdate: vi.fn((cfg: { set: Record<string, unknown> }) => {
            upsertSets.push(cfg.set);
            return Promise.resolve([]);
          }),
        };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      deleteCalls.push(table);
      return { where: vi.fn(() => Promise.resolve([])) };
    }),
  };
  return { mockDb, inserted, upsertSets, deleteCalls, noteRows, bumpVersion };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion }));

import { createAccessToken } from "../../../src/services/auth.ts";
import { eventInternalNotes } from "../../../src/db/schema/retreats.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  status: "published",
  featuredAt: null,
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

const put = async (body: Record<string, unknown>) =>
  testJson("/api/admin/events/5", {
    method: "PUT",
    headers: await auth(),
    body: JSON.stringify(body),
  });

describe("admin events: internal notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserted.length = 0;
    upsertSets.length = 0;
    deleteCalls.length = 0;
    noteRows.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  it("should return the stored notes on GET", async () => {
    noteRows.push({ notes: "Video of last 3 sessions missing" });
    const { status, body } = await testJson("/api/admin/events/5", { headers: await auth() });
    expect(status).toBe(200);
    expect(body.internalNotes).toBe("Video of last 3 sessions missing");
  });

  it("should return an empty string on GET when the event has no notes", async () => {
    const { body } = await testJson("/api/admin/events/5", { headers: await auth() });
    expect(body.internalNotes).toBe("");
  });

  it("should upsert the notes as typed on PUT", async () => {
    const { status, body } = await put({ internalNotes: "  Missing video\n" });
    expect(status).toBe(200);
    expect(inserted).toEqual([expect.objectContaining({ eventId: 5, notes: "  Missing video\n" })]);
    expect(upsertSets[0]).toMatchObject({ notes: "  Missing video\n" });
    expect(deleteCalls).not.toContain(eventInternalNotes);
    expect(body.internalNotes).toBeDefined();
  });

  it("should delete the notes on PUT when they are blank", async () => {
    await put({ internalNotes: "   " });
    expect(deleteCalls).toContain(eventInternalNotes);
    expect(inserted).toHaveLength(0);
  });

  it("should not touch the notes on PUT when the field is absent", async () => {
    await put({ titleEn: "New title" });
    expect(deleteCalls).not.toContain(eventInternalNotes);
    expect(inserted).toHaveLength(0);
  });

  it("should reject notes longer than 20000 characters", async () => {
    const { status } = await put({ internalNotes: "x".repeat(20001) });
    expect(status).toBe(400);
  });
});
