import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = "true";
});

vi.mock("../../src/db/index.ts", () => ({
  db: { query: { events: { findFirst: vi.fn(async () => undefined) } } },
}));

import { testRequest } from "../helpers.ts";

describe("POST /api/teachings/:eventId/checkout rate limit", () => {
  it("should answer 429 after the auth IP limit is exceeded", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await testRequest("/api/teachings/8/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" },
        body: "{}",
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses).toContain(429);
  });
});
