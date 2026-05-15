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
 */

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
  } catch (err) {
    // Best-effort cleanup: if startMinio() threw after the process spawned,
    // call stopMinio() so neither the child process nor its temp dir is orphaned.
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
