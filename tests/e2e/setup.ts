/**
 * Per-file environment setup for the e2e test suite.
 *
 * This file runs via `setupFiles` in vitest.e2e.config.ts, which means it
 * executes once per test file — before any imports of src/ modules that read
 * process.env at import time (e.g. src/config.ts). All env vars must be set
 * here so that config.ts sees consistent values regardless of import order.
 */

// Import constants from support modules so values stay in sync with the
// infrastructure helpers. These modules export plain literals and perform no
// side-effects, so importing them here is safe.
import { TEST_DATABASE_URL } from "./support/database.ts";
import {
  MINIO_ENDPOINT,
  MINIO_BUCKET,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "./support/minio.ts";

// ── Core runtime ──────────────────────────────────────────────────────────────
process.env.NODE_ENV = "test";

// ── Database ──────────────────────────────────────────────────────────────────
process.env.DATABASE_URL = TEST_DATABASE_URL;

// ── E2E flag (disables mocks that guard against real I/O in unit tests) ───────
process.env.E2E_ENABLED = "true";

// ── S3 / MinIO ────────────────────────────────────────────────────────────────
process.env.S3_ENDPOINT = MINIO_ENDPOINT;
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.S3_BUCKET = MINIO_BUCKET;
process.env.AWS_ACCESS_KEY_ID = MINIO_ACCESS_KEY;
process.env.AWS_SECRET_ACCESS_KEY = MINIO_SECRET_KEY;
process.env.AWS_REGION = "us-east-1";

// ── Authentication ────────────────────────────────────────────────────────────
process.env.JWT_SECRET = "test-secret-do-not-use-in-production";

// ── Bunny Stream (copied from tests/setup.ts so config.ts does not throw) ─────
process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
process.env.BUNNY_STREAM_API_KEY = "test-api-key";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_STREAM_TOKEN_AUTH_KEY = "test-token-auth-key";
process.env.BUNNY_STREAM_PLAYBACK_TTL = "3600";
process.env.BUNNY_WEBHOOK_SECRET = "test-webhook-secret";
