import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = "true";
});

vi.mock("../../src/db/index.ts", () => ({ db: {} }));

import { testRequest } from "../helpers.ts";

describe("POST /api/csp-report rate limit", () => {
  it("should answer 429 once an IP exceeds 120 reports a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 122; i++) {
      const res = await testRequest("/api/csp-report", {
        method: "POST",
        headers: { "x-forwarded-for": "7.7.7.7", "Content-Type": "application/csp-report" },
        body: "{}",
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 120).every((s) => s === 204)).toBe(true);
    expect(statuses.slice(120)).toEqual([429, 429]);
  });
});
