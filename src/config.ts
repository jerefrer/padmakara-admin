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

  database: {
    url: env("DATABASE_URL", "postgresql://localhost:5432/padmakara"),
  },

  jwt: {
    secret: env("JWT_SECRET", "dev-secret-change-in-production"),
    accessTokenExpiry: env("JWT_ACCESS_TOKEN_EXPIRY", "15m"),
    refreshTokenExpiry: env("JWT_REFRESH_TOKEN_EXPIRY", "7d"),
  },

  aws: {
    accessKeyId: env("AWS_ACCESS_KEY_ID", ""),
    secretAccessKey: env("AWS_SECRET_ACCESS_KEY", ""),
    region: env("AWS_REGION", "eu-west-3"),
    s3Bucket: env("S3_BUCKET", "padmakara-pt"),
  },

  email: {
    fromEmail: env("SES_FROM_EMAIL", "noreply@padmakara.org"),
  },

  urls: {
    frontend: env("FRONTEND_URL", "http://localhost:8081"),
    admin: env("ADMIN_URL", "http://localhost:3000/admin"),
  },
} as const;
