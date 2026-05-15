/**
 * Vitest globalSetup for the e2e test suite.
 *
 * Boots shared infrastructure once per test run (not per file). The returned
 * teardown function shuts everything down after the last test file finishes.
 *
 * Execution order within a run:
 *   globalSetup (this file) → setupFiles (tests/e2e/setup.ts) → test files
 *
 * Infrastructure started here:
 *   1. PostgreSQL test database — reset to a clean, fully-migrated state.
 *   2. MinIO — local S3-compatible object store for audio/PDF fixtures.
 *   3. Seed the test database with the deterministic e2e dataset.
 *   4. Upload placeholder fixture media to MinIO for every seeded S3 key.
 *
 * Environment note:
 *   globalSetup runs in a separate Bun/Node process that does NOT benefit from
 *   the Vitest `setupFiles` (tests/e2e/setup.ts). Any src/ module that reads
 *   process.env at import time (config.ts → s3.ts) will see empty values unless
 *   we populate them ourselves BEFORE those modules are first evaluated.
 *
 *   We satisfy this by setting the required S3 / DB env vars at the very top of
 *   this module, before any static import of code that transitively pulls in
 *   config.ts. Imports that do NOT touch config.ts (database.ts, minio.ts) are
 *   safe as static imports. seed.ts (→ db) and media.ts (→ s3) are loaded via
 *   dynamic `import()` so their evaluation is deferred until after env vars are
 *   set.
 */

import { TEST_DATABASE_URL } from "./database.ts";
import {
  MINIO_ENDPOINT,
  MINIO_BUCKET,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "./minio.ts";

// ── Set env vars before any src/ module is evaluated ──────────────────────────
// config.ts reads these at module initialisation time; the S3Client in s3.ts is
// created at module level from config, so the vars must be in place before the
// first `import` of anything that transitively pulls in s3.ts.
process.env.NODE_ENV            = "test";
process.env.DATABASE_URL        = TEST_DATABASE_URL;
process.env.E2E_ENABLED         = "true";
process.env.S3_ENDPOINT         = MINIO_ENDPOINT;
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.S3_BUCKET           = MINIO_BUCKET;
process.env.AWS_ACCESS_KEY_ID   = MINIO_ACCESS_KEY;
process.env.AWS_SECRET_ACCESS_KEY = MINIO_SECRET_KEY;
process.env.AWS_REGION          = "us-east-1";
process.env.JWT_SECRET          = "test-secret-do-not-use-in-production";
// Bunny / Easypay — config.ts requires these; provide safe dummy values.
process.env.BUNNY_STREAM_LIBRARY_ID   = "12345";
process.env.BUNNY_STREAM_API_KEY      = "test-api-key";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_STREAM_TOKEN_AUTH_KEY = "test-token-auth-key";
process.env.BUNNY_STREAM_PLAYBACK_TTL = "3600";
process.env.BUNNY_WEBHOOK_SECRET      = "test-webhook-secret";

// ── Safe to import now that env vars are in place ─────────────────────────────
import { resetTestDatabase } from "./database.ts";
import { startMinio, stopMinio } from "./minio.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  try {
    // 1. Reset the test database first — migrations may take a few seconds and
    //    we want the schema ready before MinIO is accepting connections, so that
    //    the overall startup sequence is deterministic.
    console.log("[e2e global-setup] Resetting test database…");
    await resetTestDatabase();
    console.log("[e2e global-setup] Test database ready.");

    // 2. Start MinIO and create the test bucket.
    console.log("[e2e global-setup] Starting MinIO…");
    await startMinio();
    console.log("[e2e global-setup] MinIO ready.");

    // 3. Seed the test database. Dynamic import defers evaluation of seed.ts
    //    (and its transitive dep on db/config) until env vars are guaranteed set.
    console.log("[e2e global-setup] Seeding test database…");
    const { seedTestData } = await import("./seed.ts");
    await seedTestData();
    console.log("[e2e global-setup] Test database seeded.");

    // 4. Upload placeholder fixture media to MinIO. Dynamic import defers
    //    evaluation of media.ts → s3.ts → config.ts until env vars are set.
    //    Must run after startMinio() (bucket exists) and seedTestData() (DB rows
    //    are inserted so S3 keys logically match the database state).
    console.log("[e2e global-setup] Uploading fixture media to MinIO…");
    const { uploadFixtureMedia } = await import("./media.ts");
    await uploadFixtureMedia();
    console.log("[e2e global-setup] Fixture media uploaded.");
  } catch (err) {
    // Best-effort cleanup: if any step threw after MinIO was spawned, stop it
    // so neither the child process nor its temp dir is orphaned.
    await stopMinio().catch(() => {});

    // Surface setup failures clearly so the developer sees infrastructure
    // problems rather than a wall of test-level errors.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[e2e global-setup] Infrastructure startup failed: ${message}`, { cause: err });
  }

  // Return the teardown function — Vitest calls it after all test files finish.
  return async function teardown(): Promise<void> {
    console.log("[e2e global-setup] Stopping MinIO…");
    await stopMinio();
    console.log("[e2e global-setup] Teardown complete.");
  };
}
