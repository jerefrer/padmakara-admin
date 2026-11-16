import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("test routes mounting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-evaluates config and the router under the given env and asks for a token. */
  async function tokenStatus(nodeEnv: string, e2eEnabled?: string): Promise<number> {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("E2E_ENABLED", e2eEnabled);
    if (nodeEnv === "production") {
      // Enough configuration for the production start-up guards to pass.
      vi.stubEnv("JWT_SECRET", "x".repeat(40));
      vi.stubEnv("READ_ALONG_WEBHOOK_SECRET", "y".repeat(40));
      vi.stubEnv("EASYPAY_ACCOUNT_ID", "account");
      vi.stubEnv("EASYPAY_API_KEY", "key");
    }
    vi.resetModules();
    const { api } = await import("../../src/routes/index.ts");
    const res = await api.request("/test/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: 1, email: "e2e@example.com" }),
    });
    return res.status;
  }

  it("should not mount the test routes in development without E2E_ENABLED", async () => {
    expect(await tokenStatus("development")).toBe(404);
  });

  it("should not mount the test routes in a staging environment", async () => {
    expect(await tokenStatus("staging")).toBe(404);
  });

  it("should mount the test routes when E2E_ENABLED is true", async () => {
    expect(await tokenStatus("development", "true")).toBe(200);
  });

  it("should never mount the test routes in production, even with E2E_ENABLED", async () => {
    expect(await tokenStatus("production", "true")).toBe(404);
  });

  it("should mount the test routes under NODE_ENV=test", async () => {
    expect(await tokenStatus("test")).toBe(200);
  });
});
