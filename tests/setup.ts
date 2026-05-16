// Test setup - runs before all test files
// For now, just ensure env is set
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-do-not-use-in-production";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://localhost:5432/padmakara_test";
// Disable rate limiting for all unit/integration tests so auth tests
// don't exhaust limits when many requests share a single in-memory limiter.
process.env.RATE_LIMIT_ENABLED = "false";

// Bunny Stream — deterministic test values used by bunny service tests.
process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
process.env.BUNNY_STREAM_API_KEY = "test-api-key";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_STREAM_TOKEN_AUTH_KEY = "test-token-auth-key";
process.env.BUNNY_STREAM_PLAYBACK_TTL = "3600";
process.env.BUNNY_WEBHOOK_SECRET = "test-webhook-secret";

// Keep each parallel Vitest worker's DB pool small so they don't collectively
// exhaust the shared padmakara_test connection limit.
process.env.DB_POOL_MAX = "3";
