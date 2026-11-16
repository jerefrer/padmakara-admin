import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = "true";
});

// Every search loads all visible events with their tracks: an empty archive keeps
// each request cheap here.
vi.mock("../../src/db/index.ts", () => ({
  db: { query: { events: { findMany: vi.fn(async () => []) } } },
}));

import { testRequest } from "../helpers.ts";

describe("GET /api/search rate limit", () => {
  it("should answer 429 once an IP exceeds 60 searches a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      const res = await testRequest("/api/search?q=bodhicitta", {
        headers: { "x-forwarded-for": "8.8.4.4" },
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
  });
});
