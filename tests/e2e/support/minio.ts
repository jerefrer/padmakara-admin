/**
 * MinIO lifecycle helper for the e2e test suite.
 *
 * Manages a local MinIO server process, providing an S3-compatible store
 * that mirrors the production AWS S3 configuration. Intended for use in
 * globalSetup / globalTeardown hooks — one instance per test run.
 *
 * Usage:
 *   import { startMinio, stopMinio } from "./tests/e2e/support/minio.ts";
 *   await startMinio();   // start server, create bucket
 *   // ... run tests ...
 *   await stopMinio();    // kill process, clean temp dir
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateBucketCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";

// ─── Public constants (single source of truth for all e2e tests) ─────────────

export const MINIO_PORT = 9100;
export const MINIO_ENDPOINT = `http://127.0.0.1:${MINIO_PORT}`;

/** Root user / access key — 8-char minimum enforced by MinIO. */
export const MINIO_ACCESS_KEY = "e2eadmin";

/** Root password / secret key — must be ≥ 8 characters. */
export const MINIO_SECRET_KEY = "e2epasswd";

/** Bucket created automatically by startMinio(). */
export const MINIO_BUCKET = "padmakara-test";

// ─── Module-level state ───────────────────────────────────────────────────────

let minioProcess: ChildProcess | null = null;
let tempDataDir: string | null = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Poll the MinIO health endpoint until it returns HTTP 200 or the timeout
 * elapses. MinIO typically starts in < 2 s on a warm machine.
 */
async function waitForReady(timeoutMs = 20_000): Promise<void> {
  const healthUrl = `${MINIO_ENDPOINT}/minio/health/ready`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.status === 200) return;
    } catch {
      // connection refused — server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `MinIO did not become ready within ${timeoutMs / 1000} s. ` +
      `Check that port ${MINIO_PORT} is free and the binary is functional.`,
  );
}

/**
 * Create the test bucket, ignoring "already exists" errors so the helper is
 * idempotent when called multiple times in the same run.
 */
async function createBucket(): Promise<void> {
  const s3 = new S3Client({
    endpoint: MINIO_ENDPOINT,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY,
      secretAccessKey: MINIO_SECRET_KEY,
    },
  });

  try {
    await s3.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
  } catch (err) {
    const code = (err as S3ServiceException).name;
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
      return; // idempotent — bucket already exists, nothing to do
    }
    throw err;
  } finally {
    s3.destroy();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a local MinIO server and prepare the test bucket.
 *
 * Steps:
 *  1. Create a unique temp directory for MinIO's object store.
 *  2. Spawn `minio server` bound to localhost:MINIO_PORT.
 *  3. Poll the health endpoint until ready (max 20 s).
 *  4. Create the test bucket via the S3 API.
 *
 * Throws if the binary is missing, the port is already in use, or MinIO
 * does not become healthy within the timeout.
 */
export async function startMinio(): Promise<void> {
  if (minioProcess !== null) {
    throw new Error("startMinio() called while MinIO is already running.");
  }

  // 1. Fresh temp directory — unique per run so parallel CI jobs don't clash.
  tempDataDir = await mkdtemp(join(tmpdir(), "minio-e2e-"));

  // 2. Spawn the MinIO server.
  minioProcess = spawn(
    "minio",
    ["server", tempDataDir, "--address", `127.0.0.1:${MINIO_PORT}`],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: MINIO_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: MINIO_SECRET_KEY,
      },
      // Inherit stderr so startup errors are visible; suppress verbose stdout.
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  // Race the readiness wait against a spawn-error rejection so that failures
  // (binary missing, port in use, etc.) propagate cleanly to the caller rather
  // than becoming uncaught exceptions thrown inside an EventEmitter handler.
  const spawnError = new Promise<never>((_, reject) => {
    minioProcess!.on("error", async (err) => {
      // Kill the process (best-effort) so it is not orphaned, then reject.
      await stopMinio().catch(() => {});
      reject(new Error(`MinIO process error: ${err.message}`));
    });
  });

  // 3. Wait for the health endpoint (or a spawn failure, whichever comes first).
  await Promise.race([waitForReady(), spawnError]);

  // 4. Create the test bucket.
  await createBucket();
}

/**
 * Stop the running MinIO server and remove its temp data directory.
 *
 * Safe to call even if `startMinio()` was never called or MinIO has already
 * exited — excess calls are silently ignored.
 */
export async function stopMinio(): Promise<void> {
  // Kill the child process if it is still alive.
  if (minioProcess !== null) {
    const proc = minioProcess;
    minioProcess = null;

    await new Promise<void>((resolve) => {
      // Give the process a moment to exit cleanly on SIGTERM.
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
        resolve();
      }, 3_000);

      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        // process may have already exited
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  // Remove the temp data directory.
  if (tempDataDir !== null) {
    const dir = tempDataDir;
    tempDataDir = null;
    await rm(dir, { recursive: true, force: true });
  }
}
