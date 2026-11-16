import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config, validateProductionConfig } from "../src/config.ts";

// Minimal config shape accepted by validateProductionConfig.
function makeConfig(overrides: {
  jwtSecret?: string;
  readAlongWebhookSecret?: string;
  bunnyWebhookSecret?: string;
  easypayAccountId?: string;
  easypayApiKey?: string;
}) {
  return {
    nodeEnv: "production",
    jwt: { secret: overrides.jwtSecret ?? "a".repeat(40) },
    readAlong: {
      webhookSecret: overrides.readAlongWebhookSecret ?? "real-webhook-secret-xyz-0123456789abcdef",
    },
    bunny: {
      webhookSecret: overrides.bunnyWebhookSecret ?? "real-bunny-webhook-secret",
    },
    easypay: {
      accountId: overrides.easypayAccountId ?? "easypay-account",
      apiKey: overrides.easypayApiKey ?? "easypay-key",
    },
  };
}

describe("config.storage", () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env = { ...saved }; vi.resetModules(); });
  afterEach(() => { process.env = { ...saved }; vi.resetModules(); });

  // config.ts reads env vars at module-evaluation time, so each case must
  // force a fresh evaluation. A query-suffixed import specifier busts
  // Vitest's module cache at runtime, but tsc can't resolve it (TS2307) —
  // vi.resetModules() + a plain re-import achieves the same fresh-eval
  // behavior while staying a valid, type-checkable module specifier.
  it("falls back to AWS_* / S3_* vars when STORAGE_* is unset", async () => {
    process.env.AWS_ACCESS_KEY_ID = "aws-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.AWS_REGION = "eu-west-3";
    process.env.S3_BUCKET = "padmakara-pt-app";
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.S3_ENDPOINT;
    const { config } = await import("../src/config.ts");
    expect(config.storage.accessKeyId).toBe("aws-key");
    expect(config.storage.bucket).toBe("padmakara-pt-app");
    expect(config.storage.endpoint).toBe("");
    expect(config.storage.forcePathStyle).toBe(false);
  });

  it("prefers STORAGE_* over AWS_* when set (R2 cutover)", async () => {
    process.env.AWS_ACCESS_KEY_ID = "aws-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.STORAGE_ACCESS_KEY_ID = "r2-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "r2-secret";
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_FORCE_PATH_STYLE = "true";
    const { config } = await import("../src/config.ts");
    expect(config.storage.accessKeyId).toBe("r2-key");
    expect(config.storage.secretAccessKey).toBe("r2-secret");
    expect(config.storage.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(config.storage.forcePathStyle).toBe(true);
  });
});

describe("config.database defaults", () => {
  it("reads DB_POOL_MAX=3 from the test env (set by tests/setup.ts)", () => {
    expect(config.database.poolMax).toBe(3);
  });
});

describe("config.anthropic defaults", () => {
  it("defaults model to claude-sonnet-5 when ANTHROPIC_MODEL is not set", () => {
    expect(config.anthropic.model).toBe("claude-sonnet-5");
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

  it("throws when READ_ALONG_WEBHOOK_SECRET is empty", () => {
    const cfg = makeConfig({ readAlongWebhookSecret: "" });
    expect(() => validateProductionConfig(cfg)).toThrow("READ_ALONG_WEBHOOK_SECRET is too short");
  });

  it("throws when READ_ALONG_WEBHOOK_SECRET is shorter than 32 characters", () => {
    const cfg = makeConfig({ readAlongWebhookSecret: "short-webhook-secret" });
    expect(() => validateProductionConfig(cfg)).toThrow("READ_ALONG_WEBHOOK_SECRET is too short");
  });

  it("throws when EASYPAY_ACCOUNT_ID is empty", () => {
    const cfg = makeConfig({ easypayAccountId: "" });
    expect(() => validateProductionConfig(cfg)).toThrow("EASYPAY_ACCOUNT_ID is empty");
  });

  it("throws when EASYPAY_API_KEY is empty", () => {
    const cfg = makeConfig({ easypayApiKey: "" });
    expect(() => validateProductionConfig(cfg)).toThrow("EASYPAY_API_KEY is empty");
  });

  it("does not throw when all secrets are strong and non-default", () => {
    const cfg = makeConfig({
      jwtSecret: "a".repeat(40),
      readAlongWebhookSecret: "b".repeat(32),
      bunnyWebhookSecret: "real-bunny-webhook-secret",
    });
    expect(() => validateProductionConfig(cfg)).not.toThrow();
  });
});

describe("config.easypay.testing default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadTesting(nodeEnv: string, value?: string): Promise<boolean> {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("EASYPAY_TESTING", value);
    if (nodeEnv === "production") {
      vi.stubEnv("JWT_SECRET", "a".repeat(40));
      vi.stubEnv("READ_ALONG_WEBHOOK_SECRET", "b".repeat(40));
      vi.stubEnv("EASYPAY_ACCOUNT_ID", "account");
      vi.stubEnv("EASYPAY_API_KEY", "key");
    }
    vi.resetModules();
    const { config } = await import("../src/config.ts");
    return config.easypay.testing;
  }

  it("should default to the live Easypay API in production", async () => {
    expect(await loadTesting("production")).toBe(false);
  });

  it("should default to the Easypay sandbox outside production", async () => {
    expect(await loadTesting("development")).toBe(true);
  });

  it("should honour an explicit EASYPAY_TESTING=true in production", async () => {
    expect(await loadTesting("production", "true")).toBe(true);
  });
});
