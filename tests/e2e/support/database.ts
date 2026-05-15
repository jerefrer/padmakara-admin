/**
 * Test-database lifecycle helper for the e2e test suite.
 *
 * Provides a single function — resetTestDatabase() — that tears down and
 * recreates the `padmakara_test` Postgres database, then applies all Drizzle
 * migrations so each suite run starts from a clean, fully-migrated schema.
 *
 * Design notes:
 *  - Maintenance operations (DROP/CREATE DATABASE) connect to the built-in
 *    `postgres` database, not to `padmakara_test`, because you cannot drop a
 *    database you are connected to.
 *  - DROP DATABASE / CREATE DATABASE cannot run inside a transaction; the
 *    `postgres` driver's tagged-template calls default to autocommit, which is
 *    exactly what we need.
 *  - Database identifiers (names) cannot be parameterized with $1 placeholders,
 *    but both names here are fixed string literals, so that is safe.
 *  - Migrations are applied by spawning `bunx drizzle-kit migrate` as a child
 *    process with DATABASE_URL pointed at the test database.
 */

import postgres from "postgres";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ─── Public constants (single source of truth) ───────────────────────────────

/**
 * Connection URL for the test database used across all e2e tests.
 *
 * Override via the TEST_DATABASE_URL environment variable to point at a
 * non-default host/port or use different credentials (e.g. in CI).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/padmakara_test";

// ─── Internal constants ───────────────────────────────────────────────────────

/**
 * Maintenance database URL, derived from TEST_DATABASE_URL so that the
 * host, port, and credentials always match the test database.
 *
 * We switch only the database name to the built-in `postgres` maintenance DB,
 * which is required for DROP DATABASE / CREATE DATABASE statements (you cannot
 * drop a database you are currently connected to).
 */
const MAINTENANCE_DATABASE_URL = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
})();

/** Absolute path to the repo root — required as cwd for drizzle-kit. */
const REPO_ROOT = join(
  import.meta.dirname,
  "..", // e2e/
  "..", // tests/
  "..", // padmakara-api/
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Drop, recreate, and migrate the `padmakara_test` database.
 *
 * Steps:
 *  1. Connect to the `postgres` maintenance database (max: 1 connection).
 *  2. Terminate all existing connections to `padmakara_test` so the DROP
 *     does not block on active clients.
 *  3. DROP DATABASE IF EXISTS padmakara_test
 *  4. CREATE DATABASE padmakara_test
 *  5. Close the maintenance connection.
 *  6. Spawn `bunx drizzle-kit migrate` with DATABASE_URL=TEST_DATABASE_URL
 *     and wait for it to exit successfully.
 *
 * Throws a descriptive error if any step fails.
 */
export async function resetTestDatabase(): Promise<void> {
  // ── Step 1: Open a single connection to the maintenance database ─────────
  const maintenance = postgres(MAINTENANCE_DATABASE_URL, {
    max: 1,
    // Disable connection-level prepare statements — not needed for DDL.
    prepare: false,
  });

  try {
    // ── Step 2: Terminate existing connections to padmakara_test ──────────
    // This prevents "other sessions are using the database" errors on DROP.
    await maintenance`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = 'padmakara_test'
        AND pid <> pg_backend_pid()
    `;

    // ── Step 3: Drop the test database if it already exists ───────────────
    // Cannot be parameterized — name is a fixed literal, so this is safe.
    await maintenance`DROP DATABASE IF EXISTS padmakara_test`;

    // ── Step 4: Recreate the test database ────────────────────────────────
    await maintenance`CREATE DATABASE padmakara_test`;
  } finally {
    // ── Step 5: Always close the maintenance connection ───────────────────
    await maintenance.end();
  }

  // ── Step 6: Apply Drizzle migrations to the fresh database ───────────────
  await runMigrations();
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Spawn `bunx drizzle-kit migrate` targeting the test database and wait for
 * it to exit. Rejects with the captured output if the exit code is non-zero.
 */
function runMigrations(): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const child = spawn("bunx", ["drizzle-kit", "migrate"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
      },
      // Capture combined stdout + stderr for error reporting.
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn drizzle-kit: ${err.message}\n` +
            Buffer.concat(chunks).toString(),
        ),
      );
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString();
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `drizzle-kit migrate exited with code ${code}.\n\n` +
              `--- captured output ---\n${output}\n--- end output ---`,
          ),
        );
      }
    });
  });
}
