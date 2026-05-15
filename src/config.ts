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

  database: {
    url: env("DATABASE_URL", "postgresql://localhost:5432/padmakara"),
  },

  jwt: {
    secret: env("JWT_SECRET", "dev-secret-change-in-production"),
    accessTokenExpiry: env("JWT_ACCESS_TOKEN_EXPIRY", "1h"),
    refreshTokenExpiry: env("JWT_REFRESH_TOKEN_EXPIRY", "365d"),
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
} as const;
