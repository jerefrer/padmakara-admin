/**
 * Standalone e2e infrastructure runner for the Playwright web-e2e suite.
 *
 * The Playwright suite (in padmakara-app) needs the same shared
 * infrastructure the Vitest e2e suite uses — a clean, migrated, seeded
 * `padmakara_test` database and a running MinIO object store — but it needs
 * MinIO to STAY UP for the whole Playwright session, not just for a single
 * setup call.
 *
 * This file is a small CLI with two modes:
 *
 *   bun playwright-infra.ts setup
 *     Resets + migrates + seeds the test database and uploads fixture media,
 *     then exits 0. Run once before MinIO must already be up — so this mode
 *     starts MinIO, does the work, and LEAVES MinIO running by detaching:
 *     it is NOT used by Playwright directly.
 *
 *   bun playwright-infra.ts run
 *     The mode Playwright's globalSetup spawns. It:
 *       1. Resets + migrates the test database.
 *       2. Starts MinIO (test bucket created).
 *       3. Seeds the test database.
 *       4. Uploads placeholder fixture media to MinIO.
 *       5. Prints the line `INFRA_READY` to stdout — Playwright's globalSetup
 *          waits for this line before returning.
 *       6. Stays alive (holding the MinIO child process) until it receives
 *          SIGTERM / SIGINT, at which point it stops MinIO and exits.
 *
 * Why a long-lived process: MinIO is a child process. If the setup helper
 * returned, MinIO would be orphaned or killed. Keeping this runner alive for
 * the whole Playwright session keeps MinIO's lifetime bound to it. Playwright
 * sends SIGTERM on teardown, which triggers a clean MinIO shutdown here.
 *
 * SAFETY: this runner ONLY ever touches the `padmakara_test` database and the
 * local MinIO store. It sets every relevant env var explicitly below before
 * importing any src/ module, so it can never read the real `.env`.
 */

import { TEST_DATABASE_URL } from "./database.ts";
import {
  MINIO_ENDPOINT,
  MINIO_BUCKET,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "./minio.ts";

// ── Set env vars before any src/ module is evaluated ──────────────────────────
// config.ts (→ s3.ts) reads these at module-init time, so they must be set
// before the first dynamic import of seed.ts / media.ts below.
process.env.NODE_ENV              = "test";
process.env.DATABASE_URL          = TEST_DATABASE_URL;
process.env.E2E_ENABLED           = "true";
process.env.S3_ENDPOINT           = MINIO_ENDPOINT;
process.env.S3_FORCE_PATH_STYLE   = "true";
process.env.S3_BUCKET             = MINIO_BUCKET;
process.env.AWS_ACCESS_KEY_ID     = MINIO_ACCESS_KEY;
process.env.AWS_SECRET_ACCESS_KEY = MINIO_SECRET_KEY;
process.env.AWS_REGION            = "us-east-1";
process.env.JWT_SECRET            = "test-secret-do-not-use-in-production";
process.env.BUNNY_STREAM_LIBRARY_ID     = "12345";
process.env.BUNNY_STREAM_API_KEY        = "test-api-key";
process.env.BUNNY_STREAM_CDN_HOSTNAME   = "vz-test.b-cdn.net";
process.env.BUNNY_STREAM_TOKEN_AUTH_KEY = "test-token-auth-key";
process.env.BUNNY_STREAM_PLAYBACK_TTL   = "3600";
process.env.BUNNY_WEBHOOK_SECRET        = "test-webhook-secret";

// ── Safe to import now ────────────────────────────────────────────────────────
import { resetTestDatabase } from "./database.ts";
import { startMinio, stopMinio } from "./minio.ts";

/** SAFETY ASSERTION — refuse to run if DATABASE_URL is not the test DB. */
function assertSafeTarget(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("padmakara_test")) {
    throw new Error(
      `[playwright-infra] REFUSING TO RUN: DATABASE_URL is not the test ` +
        `database (got "${url}"). Expected a URL containing "padmakara_test".`,
    );
  }
  const endpoint = process.env.S3_ENDPOINT ?? "";
  if (!endpoint.includes("127.0.0.1") && !endpoint.includes("localhost")) {
    throw new Error(
      `[playwright-infra] REFUSING TO RUN: S3_ENDPOINT is not local MinIO ` +
        `(got "${endpoint}").`,
    );
  }
}

/** Reset + migrate the DB, start MinIO, seed, and upload fixture media. */
async function provision(): Promise<void> {
  assertSafeTarget();

  console.log("[playwright-infra] Resetting test database…");
  await resetTestDatabase();
  console.log("[playwright-infra] Test database reset + migrated.");

  console.log("[playwright-infra] Starting MinIO…");
  await startMinio();
  console.log("[playwright-infra] MinIO ready.");

  console.log("[playwright-infra] Seeding test database…");
  const { seedTestData } = await import("./seed.ts");
  await seedTestData();
  console.log("[playwright-infra] Test database seeded.");

  console.log("[playwright-infra] Uploading fixture media to MinIO…");
  const { uploadFixtureMedia } = await import("./media.ts");
  await uploadFixtureMedia();
  console.log("[playwright-infra] Fixture media uploaded.");
}

/**
 * `run` mode: provision, signal readiness, then idle holding MinIO until a
 * termination signal arrives.
 */
async function runMode(): Promise<void> {
  try {
    await provision();
  } catch (err) {
    await stopMinio().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[playwright-infra] Provisioning failed: ${message}`);
    process.exit(1);
  }

  // Readiness marker — Playwright's globalSetup waits for this exact line.
  console.log("INFRA_READY");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[playwright-infra] Received ${signal}, stopping MinIO…`);
    await stopMinio().catch(() => {});
    console.log("[playwright-infra] Teardown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the event loop alive indefinitely.
  await new Promise<void>(() => {});
}

const mode = process.argv[2];

if (mode === "run") {
  await runMode();
} else if (mode === "setup") {
  // One-shot mode for manual use: provision then exit. MinIO is stopped so
  // nothing is left orphaned (this mode is NOT what Playwright uses).
  try {
    await provision();
    await stopMinio();
    console.log("[playwright-infra] Setup complete (MinIO stopped).");
    process.exit(0);
  } catch (err) {
    await stopMinio().catch(() => {});
    console.error("[playwright-infra] Setup failed:", err);
    process.exit(1);
  }
} else {
  console.error(
    `[playwright-infra] Unknown mode "${mode}". Usage: bun playwright-infra.ts <run|setup>`,
  );
  process.exit(1);
}
