import { describe, it, expect } from "vitest";
import { testJson } from "../helpers.ts";

describe("Health check", () => {
  it("GET /health returns ok", async () => {
    const { status, body } = await testJson("/health");

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /nonexistent returns 404", async () => {
    const { status, body } = await testJson("/nonexistent");

    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });
});
