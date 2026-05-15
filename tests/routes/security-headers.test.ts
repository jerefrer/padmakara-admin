import { describe, it, expect } from "vitest";
import { testRequest } from "../helpers.ts";

describe("Security headers", () => {
  it("GET /health includes X-Content-Type-Options: nosniff", async () => {
    const res = await testRequest("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("GET /health includes X-Frame-Options header", async () => {
    const res = await testRequest("/health");
    const frameOptions = res.headers.get("X-Frame-Options");
    expect(frameOptions).toBeTruthy();
    // Hono's default secureHeaders sets SAMEORIGIN
    expect(frameOptions).toBe("SAMEORIGIN");
  });
});
