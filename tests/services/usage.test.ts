import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.unmock("../../src/services/usage.ts");

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    inserts: [] as { values: Record<string, unknown>; conflict?: Record<string, unknown> }[],
    deleteWhere: undefined as unknown,
    fail: false,
    videoEvent: [] as { eventId: number | null }[],
  };
  const mockDb = {
    insert: vi.fn(() => {
      const entry: { values: Record<string, unknown>; conflict?: Record<string, unknown> } = { values: {} };
      const chain: any = {
        values: (v: Record<string, unknown>) => {
          entry.values = v;
          state.inserts.push(entry);
          return chain;
        },
        onConflictDoUpdate: (c: Record<string, unknown>) => {
          entry.conflict = c;
          return state.fail ? Promise.reject(new Error("db down")) : Promise.resolve();
        },
        onConflictDoNothing: () =>
          state.fail ? Promise.reject(new Error("db down")) : Promise.resolve(),
      };
      return chain;
    }),
    delete: vi.fn(() => ({
      where: vi.fn((w: unknown) => {
        state.deleteWhere = w;
        return Promise.resolve();
      }),
    })),
    select: vi.fn(() => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => void) => resolve(state.videoEvent),
      };
      return chain;
    }),
  };
  return { mockDb, state };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));

import {
  lisbonDay,
  countUsage,
  markActive,
  countAppOpen,
  countVideoStart,
  isFirstChunkRequest,
  pruneUsage,
  resetUsageStateForTests,
} from "../../src/services/usage.ts";

const dialect = new PgDialect();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  state.inserts = [];
  state.deleteWhere = undefined;
  state.fail = false;
  state.videoEvent = [];
  resetUsageStateForTests();
});

describe("lisbonDay", () => {
  it("should return the Europe/Lisbon calendar date when UTC is already the next day in summer", () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in Lisbon (UTC+1)
    expect(lisbonDay(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });

  it("should return the same date when Lisbon and UTC agree in winter", () => {
    expect(lisbonDay(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });
});

describe("countUsage", () => {
  it("should upsert today's counter for the metric and event", async () => {
    countUsage("transcript_open", 7);
    await flush();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.values).toMatchObject({ metric: "transcript_open", eventId: 7, count: 1 });
    expect(state.inserts[0]!.values.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.inserts[0]!.conflict).toBeDefined();
  });

  it("should use event id 0 when no event is given", async () => {
    countUsage("app_open");
    await flush();
    expect(state.inserts[0]!.values.eventId).toBe(0);
  });

  it("should never throw nor reject when the database fails", async () => {
    state.fail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => countUsage("file_open", 1)).not.toThrow();
    await flush();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("should return before the write completes", () => {
    expect(countUsage("file_open", 1)).toBeUndefined();
  });
});

describe("markActive", () => {
  it("should write a user's row once per day however many requests they make", async () => {
    markActive(5);
    markActive(5);
    markActive(5);
    await flush();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.values).toMatchObject({ userId: 5 });
  });

  it("should write one row per distinct user", async () => {
    markActive(5);
    markActive(6);
    await flush();
    expect(state.inserts).toHaveLength(2);
  });

  it("should retry on the next request when the write failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    state.fail = true;
    markActive(5);
    await flush();
    state.fail = false;
    markActive(5);
    await flush();
    expect(state.inserts).toHaveLength(2);
    err.mockRestore();
  });
});

describe("countAppOpen", () => {
  it("should count at most once per user per hour", async () => {
    const t = Date.parse("2026-11-13T10:00:00Z");
    countAppOpen(5, t);
    countAppOpen(5, t + 30 * 60 * 1000);
    countAppOpen(5, t + 61 * 60 * 1000);
    countAppOpen(6, t);
    await flush();
    const opens = state.inserts.filter((i) => i.values.metric === "app_open");
    expect(opens).toHaveLength(3);
  });
});

describe("countVideoStart", () => {
  it("should count against the event the video belongs to", async () => {
    state.videoEvent = [{ eventId: 42 }];
    countVideoStart(9);
    await flush();
    expect(state.inserts[0]!.values).toMatchObject({ metric: "video_start", eventId: 42 });
  });

  it("should count nothing when the video is unknown", async () => {
    state.videoEvent = [];
    countVideoStart(9);
    await flush();
    expect(state.inserts).toHaveLength(0);
  });
});

describe("isFirstChunkRequest", () => {
  it("should accept a request without a Range header", () => {
    expect(isFirstChunkRequest(undefined)).toBe(true);
  });
  it("should accept a range starting at 0", () => {
    expect(isFirstChunkRequest("bytes=0-1023")).toBe(true);
    expect(isFirstChunkRequest("bytes=0-")).toBe(true);
  });
  it("should reject a range starting mid-file", () => {
    expect(isFirstChunkRequest("bytes=1024-2047")).toBe(false);
  });
});

describe("pruneUsage", () => {
  it("should delete only user_active_days rows older than 13 months", async () => {
    await pruneUsage(new Date("2026-11-13T12:00:00Z"));
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    const q = dialect.sqlToQuery(state.deleteWhere as SQL);
    expect(q.sql).toContain('"day" <');
    expect(q.params).toContain("2025-10-13");
  });
});
