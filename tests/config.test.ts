import { describe, it, expect } from "vitest";
import { config, validateProductionConfig } from "../src/config.ts";

// Minimal config shape accepted by validateProductionConfig.
function makeConfig(overrides: {
  jwtSecret?: string;
  readAlongWebhookSecret?: string;
  bunnyWebhookSecret?: string;
}) {
  return {
    nodeEnv: "production",
    jwt: { secret: overrides.jwtSecret ?? "a".repeat(40) },
    readAlong: {
      webhookSecret: overrides.readAlongWebhookSecret ?? "real-webhook-secret-xyz",
    },
    bunny: {
      webhookSecret: overrides.bunnyWebhookSecret ?? "real-bunny-webhook-secret",
    },
  };
}

describe("config.database defaults", () => {
  it("reads DB_POOL_MAX=3 from the test env (set by tests/setup.ts)", () => {
    expect(config.database.poolMax).toBe(3);
  });
});

describe("config.anthropic defaults", () => {
  it("defaults model to claude-sonnet-4-6 when ANTHROPIC_MODEL is not set", () => {
    expect(config.anthropic.model).toBe("claude-sonnet-4-6");
  });

  it("exposes apiKey as a string", () => {
    expect(typeof config.anthropic.apiKey).toBe("string");
  });
});

describe("validateProductionConfig", () => {
  it("throws when JWT_SECRET equals the publicly-known dev default", () => {
    const cfg = makeConfig({ jwtSecret: "dev-secret-change-in-production" });
    expect(() => validateProductionConfig(cfg)).toThrow(
      "JWT_SECRET is set to the publicly-known development default"
    );
  });

  it("throws when JWT_SECRET is shorter than 32 characters", () => {
    const cfg = makeConfig({ jwtSecret: "short-secret" });
    expect(() => validateProductionConfig(cfg)).toThrow("JWT_SECRET is too short");
  });

  it("throws when READ_ALONG_WEBHOOK_SECRET equals the publicly-known dev default", () => {
    const cfg = makeConfig({ readAlongWebhookSecret: "dev-webhook-secret" });
    expect(() => validateProductionConfig(cfg)).toThrow(
      "READ_ALONG_WEBHOOK_SECRET is set to the publicly-known development default"
    );
  });

  it("throws when BUNNY_WEBHOOK_SECRET is empty", () => {
    const cfg = makeConfig({ bunnyWebhookSecret: "" });
    expect(() => validateProductionConfig(cfg)).toThrow("BUNNY_WEBHOOK_SECRET is empty");
  });

  it("does not throw when all secrets are strong and non-default", () => {
    const cfg = makeConfig({
      jwtSecret: "a".repeat(40),
      readAlongWebhookSecret: "real-webhook-secret-xyz",
      bunnyWebhookSecret: "real-bunny-webhook-secret",
    });
    expect(() => validateProductionConfig(cfg)).not.toThrow();
  });
});
