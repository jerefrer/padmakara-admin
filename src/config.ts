function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: parseInt(env("PORT", "3000"), 10),
  nodeEnv: env("NODE_ENV", "development"),
  isDev: env("NODE_ENV", "development") === "development",
  e2eEnabled: env("E2E_ENABLED", "false") === "true",
  rateLimit: {
    enabled: env("RATE_LIMIT_ENABLED", "true") === "true",
  },

  database: {
    url: env("DATABASE_URL", "postgresql://localhost:5432/padmakara"),
    // Connections per process. Lowered for the test env (many parallel
    // Vitest workers share one Postgres) — see tests/setup.ts.
    poolMax: parseInt(env("DB_POOL_MAX", "10"), 10),
  },

  jwt: {
    secret: env("JWT_SECRET", "dev-secret-change-in-production"),
    accessTokenExpiry: env("JWT_ACCESS_TOKEN_EXPIRY", "1h"),
    refreshTokenExpiry: env("JWT_REFRESH_TOKEN_EXPIRY", "60d"),
  },

  aws: {
    accessKeyId: env("AWS_ACCESS_KEY_ID", ""),
    secretAccessKey: env("AWS_SECRET_ACCESS_KEY", ""),
    region: env("AWS_REGION", "eu-west-3"),
    s3Bucket: env("S3_BUCKET", "padmakara-pt-app"),
    endpoint: env("S3_ENDPOINT", ""),
    forcePathStyle: env("S3_FORCE_PATH_STYLE", "false") === "true",
  },

  email: {
    fromEmail: env("SES_FROM_EMAIL", "no-reply@padmakara.pt"),
  },

  easypay: {
    accountId: env("EASYPAY_ACCOUNT_ID", ""),
    apiKey: env("EASYPAY_API_KEY", ""),
    testing: env("EASYPAY_TESTING", "true") === "true",
  },

  urls: {
    frontend: env("FRONTEND_URL", "http://localhost:8081"),
    admin: env("ADMIN_URL", "http://localhost:5173"),
    backend: env("BACKEND_URL", "http://localhost:3000"),
  },

  readAlong: {
    jobDefinition: env("BATCH_JOB_DEFINITION", "padmakara-read-along"),
    jobQueue: env("BATCH_JOB_QUEUE", "padmakara-read-along-queue"),
    webhookSecret: env("READ_ALONG_WEBHOOK_SECRET", "dev-webhook-secret"),
  },

  bunny: {
    libraryId: env("BUNNY_STREAM_LIBRARY_ID", ""),
    apiKey: env("BUNNY_STREAM_API_KEY", ""),
    cdnHostname: env("BUNNY_STREAM_CDN_HOSTNAME", ""),
    tokenAuthKey: env("BUNNY_STREAM_TOKEN_AUTH_KEY", ""),
    playbackTtlSeconds: parseInt(env("BUNNY_STREAM_PLAYBACK_TTL", "3600"), 10),
    /**
     * Shared secret appended to the webhook URL as `?secret=...`. Configure the
     * same value in the Bunny library "Webhook URL" setting. If blank, the
     * webhook endpoint refuses all requests.
     */
    webhookSecret: env("BUNNY_WEBHOOK_SECRET", ""),
  },

  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY", ""),
    // Session-grouping is a reasoning task; default to Sonnet rather than the
    // Haiku model used elsewhere for simple text rewrites. Sonnet 5 (over 4.6)
    // gives far more reliable tool-call JSON — 4.6 sometimes stringified the
    // delta arrays or mis-escaped quotes in corrupted filenames, which broke
    // the whole analysis; see callClaudeForChunk / DELTA_TOOL in track-analysis.
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5"),
    defaultTranslateModel: env("ANTHROPIC_TRANSLATE_MODEL", "claude-opus-4-8"),
  },

  importer: {
    zipExtractorFn: env("IMPORT_ZIP_EXTRACTOR_FN", "padmakara-zip-extractor"),
  },

  google: {
    /**
     * Optional Drive API key used to validate and resolve public Google
     * Drive links pasted by admins (video import-from-URL). When blank, the
     * import still works via the undocumented usercontent download URL.
     */
    apiKey: env("GOOGLE_API_KEY", ""),
  },
} as const;

type ProductionConfigInput = {
  nodeEnv: string;
  jwt: { secret: string };
  readAlong: { webhookSecret: string };
  bunny: { webhookSecret: string };
};

const KNOWN_DEV_JWT_SECRET = "dev-secret-change-in-production";
const KNOWN_DEV_WEBHOOK_SECRET = "dev-webhook-secret";
const MIN_JWT_SECRET_LENGTH = 32;

export function validateProductionConfig(cfg: ProductionConfigInput): void {
  if (cfg.jwt.secret === KNOWN_DEV_JWT_SECRET) {
    throw new Error(
      "FATAL: JWT_SECRET is set to the publicly-known development default. " +
        "Set a strong, unique JWT_SECRET (≥32 characters) before starting in production."
    );
  }
  if (cfg.jwt.secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `FATAL: JWT_SECRET is too short (${cfg.jwt.secret.length} chars). ` +
        `Production requires at least ${MIN_JWT_SECRET_LENGTH} characters.`
    );
  }
  if (cfg.readAlong.webhookSecret === KNOWN_DEV_WEBHOOK_SECRET) {
    throw new Error(
      "FATAL: READ_ALONG_WEBHOOK_SECRET is set to the publicly-known development default. " +
        "Set a strong, unique READ_ALONG_WEBHOOK_SECRET before starting in production."
    );
  }
  if (cfg.bunny.webhookSecret === "") {
    throw new Error(
      "FATAL: BUNNY_WEBHOOK_SECRET is empty. " +
        "Set a non-empty BUNNY_WEBHOOK_SECRET before starting in production."
    );
  }
}

if (config.nodeEnv === "production") validateProductionConfig(config);
