import { describe, it, expect } from "vitest";
import { testJson } from "../helpers.ts";
import { verifyToken } from "../../src/services/auth.ts";

describe("POST /api/test/token", () => {
  it("mints a valid JWT for the given identity", async () => {
    const { status, body } = await testJson("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ userId: 42, email: "e2e@example.com", role: "user" }),
    });
    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    const payload = await verifyToken(body.token);
    expect(payload.sub).toBe("42");
    expect(payload.email).toBe("e2e@example.com");
    expect(payload.role).toBe("user");
  });

  it("returns 400 for an invalid body", async () => {
    const { status } = await testJson("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ email: "no-user-id@example.com" }),
    });
    expect(status).toBe(400);
  });
});
