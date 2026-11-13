import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "../../helpers.ts";

// Each db.select() takes the next queued result, in the order the service
// issues its queries (stage one in order, then the per-event stage two).
const { state } = vi.hoisted(() => ({
  state: { queue: [] as unknown[][], selects: 0 },
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
      chain.then = (resolve: (v: unknown) => void) => resolve(result);
      return chain;
    }),
  },
}));

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
    [{ id: 3, titleEn: "Spring", titlePt: "Primavera", listeners: 14, completedTracks: 22, listenSeconds: 7200 }],
    [{ eventId: 3, n: 5 }], // video viewers
    [
      { eventId: 3, metric: "transcript_open", n: 8 },
      { eventId: 3, metric: "file_open", n: 2 },
      { eventId: 3, metric: "video_start", n: 6 },
      { eventId: 3, metric: "zip_download", n: 1 },
    ],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.queue = [];
  state.selects = 0;
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
    expect(body.monthly[11]).toMatchObject({ month: "2026-11", signups: 2, activeUsers: 18, teachingSalesCents: 1500, membershipCents: 0 });
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
        listeners: 14,
        completedTracks: 22,
        listenHours: 2,
        videoViewers: 5,
        transcriptOpens: 8,
        fileOpens: 2,
        videoStarts: 6,
        zipDownloads: 1,
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
    expect(state.selects).toBe(13);
  });

  it("should not expose any email, name or user id", async () => {
    queueFullResponse();
    const res = await testRequest("/api/admin/statistics", { headers: await adminHeaders() });
    const text = await res.text();
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/userId|user_id|email|firstName|lastName|dharmaName/i);
  });
});
