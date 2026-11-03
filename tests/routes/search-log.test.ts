import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { testRequest } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    inserted: [] as Record<string, unknown>[],
    deleteWhere: undefined as unknown,
    selectWheres: [] as unknown[],
    selectResults: [] as unknown[][],
  };
  const mockDb = {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        state.inserted.push(v);
        return Promise.resolve();
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((w: unknown) => {
        state.deleteWhere = w;
        return Promise.resolve();
      }),
    })),
    select: vi.fn(() => {
      const chain: any = {
        from: () => chain,
        where: (w: unknown) => {
          state.selectWheres.push(w);
          return chain;
        },
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => void) =>
          resolve(state.selectResults.shift() ?? []),
      };
      return chain;
    }),
  };
  return { mockDb, state };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));

import { createAccessToken } from "../../src/services/auth.ts";
import {
  normalizeLoggedQuery,
  purgeIfDue,
  purgeOldSearches,
  resetPurgeStateForTests,
  getSearchStats,
} from "../../src/services/search-log.ts";

const dialect = new PgDialect();

function postLog(body: unknown, headers: Record<string, string> = {}) {
  return testRequest("/api/search/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inserted = [];
  state.deleteWhere = undefined;
  state.selectWheres = [];
  state.selectResults = [];
  resetPurgeStateForTests();
});

describe("normalizeLoggedQuery", () => {
  it("should trim, collapse whitespace and lowercase", () => {
    expect(normalizeLoggedQuery("  Buddha   NATURE \n")).toBe("buddha nature");
  });

  it("should cut to 200 characters", () => {
    expect(normalizeLoggedQuery("a".repeat(500))).toHaveLength(200);
  });

  it("should return null when fewer than 2 characters remain", () => {
    expect(normalizeLoggedQuery("  a  ")).toBeNull();
    expect(normalizeLoggedQuery("   ")).toBeNull();
  });
});

describe("POST /api/search/log", () => {
  it("should store a normalised query and return 204", async () => {
    const res = await postLog({ query: "  Bodhi   Citta ", resultCount: 3, language: "pt" });

    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([
      { query: "bodhi citta", resultCount: 3, language: "pt" },
    ]);
  });

  it("should not store but still return 204 when query is under 2 characters", async () => {
    const res = await postLog({ query: " x ", resultCount: 0 });

    expect(res.status).toBe(204);
    expect(state.inserted).toHaveLength(0);
  });

  it("should store null language when omitted", async () => {
    await postLog({ query: "emptiness", resultCount: 0 });

    expect(state.inserted[0]?.language).toBeNull();
  });

  it("should return 400 when resultCount is negative", async () => {
    const res = await postLog({ query: "abc", resultCount: -1 });
    expect(res.status).toBe(400);
  });

  it("should return 400 when language is unsupported", async () => {
    const res = await postLog({ query: "abc", resultCount: 1, language: "fr" });
    expect(res.status).toBe(400);
  });

  it("should return 400 when body is not JSON", async () => {
    const res = await testRequest("/api/search/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("should store no user identifier when the caller is signed in", async () => {
    const token = await createAccessToken({ sub: 42, email: "me@test.com", role: "user" });

    const res = await postLog(
      { query: "bodhicitta", resultCount: 2, userId: 42, deviceId: "d1" },
      { Authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(204);
    expect(Object.keys(state.inserted[0]!).sort()).toEqual(["language", "query", "resultCount"]);
  });
});

describe("retention purge", () => {
  it("should delete rows older than 24 months", async () => {
    const now = new Date("2026-11-03T12:00:00Z");

    await purgeOldSearches(now);

    const { params } = dialect.sqlToQuery(state.deleteWhere as SQL);
    const cutoff = new Date(params[0] as string);
    expect(cutoff.getFullYear()).toBe(2024);
    expect(cutoff.getMonth()).toBe(10);
  });

  it("should run at most once per day", async () => {
    purgeIfDue(10_000_000_000);
    purgeIfDue(10_000_000_000 + 60_000);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);

    purgeIfDue(10_000_000_000 + 25 * 60 * 60 * 1000);
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });

  it("should trigger from the log endpoint", async () => {
    await postLog({ query: "abc", resultCount: 1 });
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });
});

describe("getSearchStats", () => {
  it("should return top, noResults and total with ISO dates", async () => {
    const last = new Date("2026-10-01T10:00:00Z");
    state.selectResults = [
      [{ query: "karma", count: 5, lastAt: last }],
      [{ query: "zzz", count: 2, lastAt: last }],
      [{ total: "7" }],
    ];

    const stats = await getSearchStats(30, new Date("2026-11-03T00:00:00Z"));

    expect(stats).toEqual({
      top: [{ query: "karma", count: 5, lastAt: last.toISOString() }],
      noResults: [{ query: "zzz", count: 2, lastAt: last.toISOString() }],
      total: 7,
    });
  });

  it("should filter by the day window and by result_count = 0 for noResults", async () => {
    await getSearchStats(90, new Date("2026-11-03T00:00:00Z"));

    const q = state.selectWheres.map((w) => dialect.sqlToQuery(w as SQL));
    const since = new Date("2026-08-05T00:00:00Z").toISOString();
    for (const query of q) {
      expect(query.params.map((p) => (p instanceof Date ? p.toISOString() : p))).toContain(since);
    }
    expect(q.some((x) => x.params.includes(0))).toBe(true);
  });
});

describe("GET /api/admin/search-queries/stats", () => {
  it("should return 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 1, email: "u@test.com", role: "user" });
    const res = await testRequest("/api/admin/search-queries/stats?days=30", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("should return 401 without a token", async () => {
    const res = await testRequest("/api/admin/search-queries/stats");
    expect(res.status).toBe(401);
  });

  it("should return stats for an admin and accept days=730", async () => {
    const token = await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });
    state.selectResults = [[], [], [{ total: 0 }]];

    const res = await testRequest("/api/admin/search-queries/stats?days=730", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ top: [], noResults: [], total: 0 });
  });

  it("should return 400 for an unsupported days value", async () => {
    const token = await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });
    const res = await testRequest("/api/admin/search-queries/stats?days=7", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});
