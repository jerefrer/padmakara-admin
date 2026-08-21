import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const eventsPage = [
  { id: 1, eventCode: "E1", eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventPublications: [] },
  { id: 2, eventCode: "E2", eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventPublications: [] },
];

vi.mock("../../../src/db/index.ts", () => {
  // db.select(...).from(...).innerJoin?(...).where(...).groupBy(...) → rows
  const makeChain = (rows: any[]) => {
    const chain: any = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.groupBy = () => Promise.resolve(rows);
    return chain;
  };
  // Return presence for event 1 across all four selects. The audio select
  // projects total/keyed as well — without them Number(undefined) is NaN and
  // hasAudio comes out false; the other three selects only read `id`.
  const selectImpl = vi.fn(() => makeChain([{ id: 1, total: 2, keyed: 2 }]));
  return {
    db: {
      query: {
        events: {
          findMany: vi.fn(() => Promise.resolve(eventsPage)),
        },
      },
      select: selectImpl,
    },
  };
});

// countRows uses db.select().from().where() → make it resolve a count too.
// (The generic select mock above returns a chain; countRows awaits the array's [0].)

import { createAccessToken } from "../../../src/services/auth.ts";
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("GET /api/admin/events content flags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets hasVideo/hasAudio/hasDocuments per event", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const e1 = body.find((e: any) => e.id === 1);
    const e2 = body.find((e: any) => e.id === 2);
    expect(e1).toMatchObject({ hasVideo: true, hasAudio: true, hasDocuments: true });
    expect(e2).toMatchObject({ hasVideo: false, hasAudio: false, hasDocuments: false });
  });
});
