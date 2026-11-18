import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "../../helpers.ts";

// Each db.select() takes the next queued result, in the order the service
// issues its queries (stage one in order, then the per-event stage two).
const { state } = vi.hoisted(() => ({
  state: { queue: [] as unknown[][], selects: 0, wheres: [] as unknown[], froms: [] as unknown[] },
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      const result = state.queue.shift() ?? [];
      const chain: any = {};
      for (const m of ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"]) {
        chain[m] = () => chain;
      }
      const index = state.selects - 1;
      chain.from = (table: unknown) => {
        state.froms[index] = table;
        return chain;
      };
      chain.where = (w: unknown) => {
        state.wheres[index] = w;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => resolve(result);
      return chain;
    }),
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { usageDailyItems } from "../../../src/db/schema/usage.ts";
import { createAccessToken } from "../../../src/services/auth.ts";
import { resolveRange, lastTwelveMonths } from "../../../src/services/statistics.ts";

const adminHeaders = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" })}`,
});

function queueFullResponse() {
  state.queue = [
    [{ n: 120 }], // total accounts
    [{ n: 9 }], // new in range
    [{ n: 40 }], // active members
    [{ n: 11 }], // active last 7
    [{ n: 30 }], // active last 30
    [{ n: 25 }], // active in range
    [{ month: "2026-10", n: 4 }, { month: "2026-11", n: 2 }], // signups per month
    [{ month: "2026-11", n: 18 }], // active users per month
    [{ month: "2026-11", cents: "1500" }], // teaching sales
    [{ month: "2026-10", amount: "17.50" }], // membership income (euros)
    [{ deviceType: "ios", n: 50 }, { deviceType: "android", n: 20 }, { deviceType: "web", n: 5 }],
    [{ day: "2026-11-12", n: 7 }], // app opens per day
    [{ id: 3, titleEn: "Spring", titlePt: "Primavera", startDate: "2026-04-10", endDate: "2026-04-12", listeners: 14, completedTracks: 22, listenSeconds: 7200 }],
    [{ month: "2026-11", n: "6" }, { month: "2026-09", n: "2" }], // read-along opens per month
    [{ eventId: 3, n: 5 }], // video viewers
    [
      { eventId: 3, metric: "transcript_open", n: 8 },
      { eventId: 3, metric: "readalong_open", n: 3 },
      { eventId: 3, metric: "file_open", n: 2 },
      { eventId: 3, metric: "video_start", n: 6 },
      { eventId: 3, metric: "zip_download", n: 1 },
      { eventId: 3, metric: "video_download", n: 4 },
    ],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.queue = [];
  state.selects = 0;
  state.wheres = [];
  state.froms = [];
});

describe("resolveRange", () => {
  const now = new Date("2026-11-13T12:00:00Z");

  it("should default to the last 30 days ending today", () => {
    expect(resolveRange(undefined, undefined, now)).toEqual({ from: "2026-10-15", to: "2026-11-13" });
  });

  it("should keep a valid explicit range", () => {
    expect(resolveRange("2026-01-01", "2026-01-31", now)).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("should reject a malformed date", () => {
    expect(() => resolveRange("yesterday", undefined, now)).toThrow();
    expect(() => resolveRange("2026-02-31", "2026-03-01", now)).toThrow();
  });

  it("should reject a range that ends before it starts", () => {
    expect(() => resolveRange("2026-02-01", "2026-01-01", now)).toThrow();
  });

  it("should reject a range longer than 400 days", () => {
    expect(() => resolveRange("2024-01-01", "2026-01-01", now)).toThrow();
  });
});

describe("lastTwelveMonths", () => {
  it("should list 12 months oldest first ending with the current one", () => {
    const months = lastTwelveMonths(new Date("2026-11-13T12:00:00Z"));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-12");
    expect(months[11]).toBe("2026-11");
  });
});

describe("GET /api/admin/statistics", () => {
  it("should return 401 without a token", async () => {
    const res = await testRequest("/api/admin/statistics");
    expect(res.status).toBe(401);
  });

  it("should return 403 for a non-admin", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const res = await testRequest("/api/admin/statistics", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("should return 400 for an invalid range", async () => {
    const res = await testRequest("/api/admin/statistics?from=2026-02-01&to=2026-01-01", {
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it("should return the aggregate shape", async () => {
    queueFullResponse();
    const res = await testRequest("/api/admin/statistics?from=2026-11-01&to=2026-11-13", {
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.range).toEqual({ from: "2026-11-01", to: "2026-11-13" });
    expect(body.accounts).toEqual({ total: 120, newInRange: 9, activeMembers: 40 });
    expect(body.activeUsers).toEqual({ last7: 11, last30: 30, inRange: 25 });

    expect(body.monthly).toHaveLength(12);
    expect(body.monthly[11]).toMatchObject({ month: "2026-11", signups: 2, activeUsers: 18, teachingSalesCents: 1500, membershipCents: 0, readAlongOpens: 6 });
    expect(body.monthly.find((m: any) => m.month === "2026-09").readAlongOpens).toBe(2);
    expect(body.monthly.find((m: any) => m.month === "2026-10").readAlongOpens).toBe(0);
    const oct = body.monthly.find((m: any) => m.month === "2026-10");
    expect(oct).toMatchObject({ signups: 4, activeUsers: 0, teachingSalesCents: 0, membershipCents: 1750 });

    expect(body.platforms).toEqual([
      { deviceType: "ios", count: 50 },
      { deviceType: "android", count: 20 },
      { deviceType: "web", count: 5 },
    ]);
    expect(body.appOpens).toEqual([{ day: "2026-11-12", count: 7 }]);
    expect(body.events).toEqual([
      {
        id: 3,
        title: "Spring",
        titlePt: "Primavera",
        startDate: "2026-04-10",
        endDate: "2026-04-12",
        listeners: 14,
        completedTracks: 22,
        listenHours: 2,
        videoViewers: 5,
        transcriptOpens: 8,
        readAlongOpens: 3,
        fileOpens: 2,
        videoStarts: 6,
        zipDownloads: 1,
        videoDownloads: 4,
      },
    ]);
  });

  it("should default to the last 30 days when no range is given", async () => {
    queueFullResponse();
    const res = await testRequest("/api/admin/statistics", { headers: await adminHeaders() });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    const days = (Date.parse(body.range.to) - Date.parse(body.range.from)) / 86_400_000;
    expect(days).toBe(29);
  });

  it("should skip the per-event queries when no event has listeners", async () => {
    queueFullResponse();
    state.queue[12] = [];
    const res = await testRequest("/api/admin/statistics", { headers: await adminHeaders() });
    const body = (await res.json()) as any;
    expect(body.events).toEqual([]);
    expect(state.selects).toBe(14);
  });

  it("should not expose any email, name or user id", async () => {
    queueFullResponse();
    const res = await testRequest("/api/admin/statistics", { headers: await adminHeaders() });
    const text = await res.text();
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/userId|user_id|email|firstName|lastName|dharmaName/i);
  });
});

describe("GET /api/admin/statistics/events/:id", () => {
  const dialect = new PgDialect();
  const URL = "/api/admin/statistics/events/3?from=2026-11-01&to=2026-11-13";

  function queueDetail() {
    state.queue = [
      [{ id: 3, titleEn: "Spring", titlePt: "Primavera", startDate: "2026-04-10", endDate: "2026-04-12" }],
      [
        { id: 31, title: "001_intro.mp3", titleEn: "Introduction", trackNumber: 1, sessionNumber: 1, sessionTitle: "Morning", listeners: 4, completions: 2, listenSeconds: "5400" },
        { id: 32, title: "002_q.mp3", titleEn: null, trackNumber: 2, sessionNumber: 1, sessionTitle: "Morning", listeners: 1, completions: 0, listenSeconds: null },
      ],
      [
        { id: 70, titleEn: "Day 1", titlePt: "Dia 1", position: 0 },
        { id: 71, titleEn: null, titlePt: null, position: 1 },
      ],
      [{ videoId: 70, n: 3 }], // video viewers
      [
        { id: 50, title: "Prayer sheet", filename: "prayer.pdf" },
        { id: 51, title: null, filename: "photo.jpg" },
      ],
      [{ id: 90, language: "en", filename: "spring-en.pdf" }],
      [
        { metric: "file_open", itemId: 50, n: "6" },
        { metric: "video_start", itemId: 70, n: "9" },
        { metric: "transcript_open", itemId: 90, n: "2" },
      ],
      [{ day: "2026-11-19" }], // first per-item day
    ];
  }

  it("should return 401 without a token", async () => {
    const res = await testRequest(URL);
    expect(res.status).toBe(401);
  });

  it("should return 403 for a non-admin", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const res = await testRequest(URL, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("should return 400 for a non-numeric id", async () => {
    const res = await testRequest("/api/admin/statistics/events/abc", { headers: await adminHeaders() });
    expect(res.status).toBe(400);
  });

  it("should return 400 for an invalid range", async () => {
    const res = await testRequest("/api/admin/statistics/events/3?from=2026-12-01&to=2026-11-01", {
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 when the event does not exist", async () => {
    state.queue = [[]];
    const res = await testRequest(URL, { headers: await adminHeaders() });
    expect(res.status).toBe(404);
  });

  it("should return per-track, per-video, per-document and per-transcript counts", async () => {
    queueDetail();
    const res = await testRequest(URL, { headers: await adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.range).toEqual({ from: "2026-11-01", to: "2026-11-13" });
    expect(body.itemsRecordedFrom).toBe("2026-11-19");
    expect(body.event).toEqual({ id: 3, title: "Spring", titlePt: "Primavera", startDate: "2026-04-10", endDate: "2026-04-12" });
    expect(body.tracks).toEqual([
      { id: 31, title: "Introduction", trackNumber: 1, sessionNumber: 1, sessionTitle: "Morning", listeners: 4, completions: 2, listenHours: 1.5 },
      { id: 32, title: "002_q.mp3", trackNumber: 2, sessionNumber: 1, sessionTitle: "Morning", listeners: 1, completions: 0, listenHours: 0 },
    ]);
    expect(body.videos).toEqual([
      { id: 70, title: "Day 1", titlePt: "Dia 1", position: 0, viewers: 3, plays: 9 },
      { id: 71, title: null, titlePt: null, position: 1, viewers: 0, plays: 0 },
    ]);
    expect(body.documents).toEqual([
      { id: 50, title: "Prayer sheet", filename: "prayer.pdf", opens: 6 },
      { id: 51, title: null, filename: "photo.jpg", opens: 0 },
    ]);
    expect(body.transcripts).toEqual([{ id: 90, language: "en", filename: "spring-en.pdf", opens: 2 }]);
  });

  it("should read per-item counts for this event and range only", async () => {
    queueDetail();
    await testRequest(URL, { headers: await adminHeaders() });
    const itemsIndex = state.froms.findIndex((t) => t === usageDailyItems);
    expect(itemsIndex).toBeGreaterThan(0);
    const q = dialect.sqlToQuery(state.wheres[itemsIndex] as SQL);
    expect(q.sql).toContain('"usage_daily_items"."event_id" =');
    expect(q.params).toEqual(expect.arrayContaining([3, "2026-11-01", "2026-11-13"]));
  });

  it("should report no recording date before any per-item count exists", async () => {
    queueDetail();
    state.queue[7] = [{ day: null }];
    const res = await testRequest(URL, { headers: await adminHeaders() });
    const body = (await res.json()) as any;
    expect(body.itemsRecordedFrom).toBeNull();
  });

  it("should not expose any email, name or user id", async () => {
    queueDetail();
    const res = await testRequest(URL, { headers: await adminHeaders() });
    const text = await res.text();
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/userId|user_id|email|firstName|lastName|dharmaName/i);
  });
});
