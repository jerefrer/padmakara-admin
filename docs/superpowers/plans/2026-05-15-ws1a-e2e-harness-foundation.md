# WS1-A — E2e Backend Harness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up the backend half of the e2e test foundation — a real `padmakara_test` Postgres database, MinIO as an S3-compatible store, an env-gated test-token endpoint, and an e2e test runner — proven by a smoke test that exercises the real app against real infrastructure.

**Architecture:** A new `tests/e2e/` tree with its own Vitest config and `globalSetup`. The global setup boots a local MinIO subprocess and resets+migrates the `padmakara_test` database; teardown stops MinIO. E2e tests reuse the existing `app.fetch` helper but run against the real database (no `vi.mock` of `db`). A new `POST /api/test/token` route, mounted only outside production, mints JWTs so tests authenticate without the magic-link flow.

**Tech Stack:** Hono, Bun, Drizzle, `postgres` driver, Vitest, `@aws-sdk/client-s3`, MinIO (standalone binary), `jose`.

**Spec:** `docs/superpowers/specs/2026-05-15-pre-launch-hardening-design.md` (§4, WS1).

**Branch:** `feature/e2e-foundation` (off `main`).

---

## Conventions

- **Repo root:** `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api` — all paths below are relative to it; all `git` uses `git -C <repo-root>`.
- **zoxide hijacks `cd`** — run commands as `sh -c 'cd <abs-repo-root> && <cmd>'`.
- **Unit test command:** `sh -c 'cd <repo-root> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run <file>'`
- Conventional Commits; commit messages end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Do not `git add` the untracked `src/scripts/fix-misattributed-pt-tracks.ts` — use explicit paths.

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/config.ts` | Config — add S3 endpoint/path-style + `e2eEnabled` | Modify |
| `src/services/s3.ts` | S3 client — honour custom endpoint | Modify |
| `src/routes/test.ts` | Env-gated test-only routes (`POST /token`) | Create |
| `src/routes/index.ts` | Mount `/api/test` when non-production | Modify |
| `tests/e2e/support/minio.ts` | Start/stop a local MinIO server for tests | Create |
| `tests/e2e/support/database.ts` | Reset + migrate the `padmakara_test` DB | Create |
| `tests/e2e/support/global-setup.ts` | Vitest `globalSetup` — boot MinIO + DB | Create |
| `tests/e2e/smoke.e2e.test.ts` | Proving e2e test against real infra | Create |
| `vitest.e2e.config.ts` | Vitest config for the e2e suite | Create |
| `tests/e2e/setup.ts` | Per-file env setup for e2e tests | Create |
| `package.json` | `test:e2e` script | Modify |
| `tests/routes/test-routes.test.ts` | Unit tests for the test-token route | Create |

---

## Setup

- [ ] **Step 0: Branch**

```bash
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api checkout main
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api checkout -b feature/e2e-foundation
```

---

## Task 1: Make the S3 client endpoint-configurable

**Why:** MinIO needs the AWS SDK pointed at a custom `endpoint` with `forcePathStyle: true`. The current `S3Client` in `s3.ts` accepts neither.

**Files:** Modify `src/config.ts`, `src/services/s3.ts`. Test: `tests/routes/test-routes.test.ts` is later — for this task add a small check to an existing or new config test if trivial; otherwise the integration is proven by Task 6.

- [ ] **Step 1: Add config keys.** In `src/config.ts`, in the `aws` config section, add two keys alongside the existing `region`/`s3Bucket`:
  - `endpoint: env("S3_ENDPOINT", "")` — when non-empty, the S3 client targets this URL (MinIO in tests).
  - `forcePathStyle: env("S3_FORCE_PATH_STYLE", "false") === "true"` — boolean.
  Also add a top-level `e2eEnabled: env("E2E_ENABLED", "false") === "true"` for later tasks.

- [ ] **Step 2: Use the endpoint in `s3.ts`.** In `src/services/s3.ts`, where `new S3Client({ ... })` is constructed, conditionally include `endpoint` and `forcePathStyle` when `config.aws.endpoint` is non-empty:

```typescript
const s3Client = new S3Client({
  region: config.aws.region,
  credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
  // keep existing requestChecksumCalculation / responseChecksumValidation options
  ...(config.aws.endpoint
    ? { endpoint: config.aws.endpoint, forcePathStyle: config.aws.forcePathStyle }
    : {}),
});
```

Preserve every existing `S3Client` option already present — only ADD the conditional `endpoint`/`forcePathStyle`.

- [ ] **Step 3: Typecheck.** `sh -c 'cd <repo-root> && /Users/jeremy/.bun/bin/bun run typecheck'` → exit 0.

- [ ] **Step 4: Commit.**

```bash
git -C <repo-root> add src/config.ts src/services/s3.ts
git -C <repo-root> commit -m "feat(api): make S3 client endpoint-configurable for MinIO" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Env-gated `POST /api/test/token` route

**Why:** E2e tests must authenticate without the interactive magic-link flow. A dev-only route mints a JWT directly.

**Files:** Create `src/routes/test.ts`, `tests/routes/test-routes.test.ts`. Modify `src/routes/index.ts`.

- [ ] **Step 1: Write the failing test.** Create `tests/routes/test-routes.test.ts`. It posts to `/api/test/token` and asserts a JWT is returned and is valid. Use the existing `testJson` helper and `verifyToken` from `src/services/auth.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { testJson } from "../helpers.ts";
import { verifyToken } from "../../src/services/auth.ts";

describe("POST /api/test/token", () => {
  it("mints a valid JWT for the given identity", async () => {
    const { status, body } = await testJson("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ userId: 42, email: "e2e@example.com", role: "user" }),
    });
    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    const payload = await verifyToken(body.token);
    expect(payload.sub).toBe("42");
    expect(payload.email).toBe("e2e@example.com");
    expect(payload.role).toBe("user");
  });

  it("returns 400 for an invalid body", async () => {
    const { status } = await testJson("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ email: "no-user-id@example.com" }),
    });
    expect(status).toBe(400);
  });
});
```

Note: `tests/setup.ts` sets `NODE_ENV="test"`, so `config.isDev` is `false` and `config.nodeEnv !== "production"`. The route's gate (Step 3) must therefore allow non-production env, not only `isDev`.

- [ ] **Step 2: Run it — verify it fails.** `vitest run tests/routes/test-routes.test.ts` → FAIL (route not found → 404).

- [ ] **Step 3: Create the route.** Create `src/routes/test.ts`:

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { createAccessToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Test-only routes. Mounted by routes/index.ts ONLY when NODE_ENV !== "production".
 * Never available in production.
 */
const testRoutes = new Hono();

const tokenSchema = z.object({
  userId: z.number().int().positive(),
  email: z.string().email(),
  role: z.enum(["user", "admin", "superadmin"]).default("user"),
});

testRoutes.post("/token", async (c) => {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid test-token request", "VALIDATION_ERROR");
  }
  const { userId, email, role } = parsed.data;
  const token = await createAccessToken({ sub: userId, email, role });
  return c.json({ token });
});

export { testRoutes };
```

Verify the import path/signature of `createAccessToken` against `src/services/auth.ts` — it takes `{ sub: number, email: string, role: string }` and returns `Promise<string>`. Adjust if the actual signature differs.

- [ ] **Step 4: Mount it conditionally.** In `src/routes/index.ts`, import `testRoutes` and `config`, and after the other `api.route(...)` calls add:

```typescript
if (config.nodeEnv !== "production") {
  api.route("/test", testRoutes);
}
```

- [ ] **Step 5: Run the test — verify it passes.** `vitest run tests/routes/test-routes.test.ts` → PASS (2 tests).

- [ ] **Step 6: Typecheck + commit.**

```bash
git -C <repo-root> add src/routes/test.ts src/routes/index.ts tests/routes/test-routes.test.ts
git -C <repo-root> commit -m "feat(api): add env-gated POST /api/test/token route for e2e auth" -m "Mounted only when NODE_ENV !== production; mints a JWT directly so e2e tests skip the magic-link flow." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MinIO test helper

**Why:** The e2e suite needs an S3-compatible store. MinIO runs as a standalone Go binary (no Docker).

**Files:** Create `tests/e2e/support/minio.ts`.

- [ ] **Step 1: Ensure the MinIO binary is available.** Run `which minio`. If absent, install it: `brew install minio/stable/minio`. Confirm `minio --version` works afterwards.

- [ ] **Step 2: Write the helper.** Create `tests/e2e/support/minio.ts` exporting `startMinio()` and `stopMinio()`:
  - `startMinio()`: spawn `minio server <tempDataDir> --address 127.0.0.1:<port>` with env `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` set to known test credentials. Use a fixed test port (e.g. `9100`) and a temp data dir under the OS temp dir. Poll `http://127.0.0.1:<port>/minio/health/ready` until 200 (timeout ~15s). Then create the test bucket using `@aws-sdk/client-s3` `CreateBucketCommand` against the MinIO endpoint (ignore "bucket already exists" errors).
  - `stopMinio()`: kill the spawned process; remove the temp data dir.
  - Export the chosen endpoint URL, credentials, and bucket name as constants so `global-setup.ts` and tests can set the matching env vars.
  - Keep it a focused single-purpose module.

- [ ] **Step 3: Smoke-check the helper manually.** Write a throwaway check (or a temporary script) that calls `startMinio()` then `stopMinio()` and confirms no error. Remove any throwaway file before committing.

- [ ] **Step 4: Commit.**

```bash
git -C <repo-root> add tests/e2e/support/minio.ts
git -C <repo-root> commit -m "test(api): add MinIO lifecycle helper for e2e suite" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Test database helper

**Why:** E2e tests run against a real `padmakara_test` Postgres database that must be created and migrated.

**Files:** Create `tests/e2e/support/database.ts`.

- [ ] **Step 1: Write the helper.** Create `tests/e2e/support/database.ts` exporting `resetTestDatabase()`:
  - Connect to the local Postgres `postgres` database (maintenance DB) using the `postgres` driver, `DROP DATABASE IF EXISTS padmakara_test` then `CREATE DATABASE padmakara_test`. (Terminate existing connections to it first via `pg_terminate_backend` if the drop fails.)
  - Apply migrations by running `drizzle-kit migrate` as a subprocess with `DATABASE_URL` set to the test DB URL (`postgresql://localhost:5432/padmakara_test`), `cwd` the repo root: `bunx drizzle-kit migrate`. Wait for it; throw on non-zero exit.
  - Export the test DB URL constant.
  - Keep the maintenance-DB connection separate and closed when done.

- [ ] **Step 2: Smoke-check manually.** Run a throwaway check that calls `resetTestDatabase()` and then queries `padmakara_test` to confirm a known table (e.g. `users`) exists. Remove the throwaway file.

- [ ] **Step 3: Commit.**

```bash
git -C <repo-root> add tests/e2e/support/database.ts
git -C <repo-root> commit -m "test(api): add test-database reset+migrate helper for e2e suite" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: E2e Vitest config + global setup

**Why:** The e2e suite needs its own Vitest project so it does not run with the mocked-DB unit tests, plus a `globalSetup` that boots infrastructure once.

**Files:** Create `vitest.e2e.config.ts`, `tests/e2e/support/global-setup.ts`, `tests/e2e/setup.ts`. Modify `package.json`.

- [ ] **Step 1: `tests/e2e/setup.ts`** — per-file setup. Sets the env vars every e2e test file needs BEFORE the app/config is imported: `NODE_ENV="test"`, `DATABASE_URL` = test DB URL, `E2E_ENABLED="true"`, `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE="true"` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `S3_BUCKET` matching the MinIO helper constants, and `JWT_SECRET="test-secret-do-not-use-in-production"`. (Mirror the pattern in `tests/setup.ts`.)

- [ ] **Step 2: `tests/e2e/support/global-setup.ts`** — exports a default async function (Vitest `globalSetup`). It calls `resetTestDatabase()` then `startMinio()`, and returns a teardown function that calls `stopMinio()`. Order: DB first, then MinIO.

- [ ] **Step 3: `vitest.e2e.config.ts`** — a Vitest config that:
  - `include: ["tests/e2e/**/*.e2e.test.ts"]`
  - `globalSetup: ["tests/e2e/support/global-setup.ts"]`
  - `setupFiles: ["tests/e2e/setup.ts"]`
  - `environment: "node"`, `globals: true`, `server.deps.inline: ["zod"]`, alias `@`→`src/` (mirror `vitest.config.ts`)
  - `testTimeout: 30000`, `hookTimeout: 60000`, and a single worker (`pool`/`poolOptions` → `singleFork`, or `maxWorkers: 1`) since the suite shares one DB.
  - Ensure the main `vitest.config.ts` `include` does NOT pick up `*.e2e.test.ts` (it currently matches `tests/**/*.test.ts` — add `exclude: ["tests/e2e/**"]` to `vitest.config.ts` so the unit run skips e2e).

- [ ] **Step 4: `package.json`** — add `"test:e2e": "vitest run --config vitest.e2e.config.ts"`.

- [ ] **Step 5: Verify the unit suite still excludes e2e.** `sh -c 'cd <repo-root> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` → still 450 passed / 6 failed, no e2e files picked up.

- [ ] **Step 6: Commit.**

```bash
git -C <repo-root> add vitest.e2e.config.ts vitest.config.ts tests/e2e/support/global-setup.ts tests/e2e/setup.ts package.json
git -C <repo-root> commit -m "test(api): add e2e Vitest config with MinIO + test-DB global setup" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Proving smoke e2e test

**Why:** Prove the whole harness works end to end: real DB, real MinIO, real app, test-token auth.

**Files:** Create `tests/e2e/smoke.e2e.test.ts`.

- [ ] **Step 1: Write the smoke test.** `tests/e2e/smoke.e2e.test.ts` — using the real `app.fetch` (via `tests/helpers.ts` `testRequest`/`testJson`, which import the real app; the e2e env vars from `setup.ts` mean `db` connects to `padmakara_test`):
  1. `GET /health` → 200.
  2. Insert a user row directly via the real `db` (import `db` from `src/db/index.ts`, insert into `users` with a known email, role `user`, `isActive`/`isVerified` true) and capture the id.
  3. `POST /api/test/token` with that user's `{ userId, email, role }` → 200, get the token.
  4. Call an authenticated endpoint with `Authorization: Bearer <token>` (e.g. `GET /api/content/progress`) → 200 (empty array is fine).
  5. Upload a small object to MinIO via the `putObject` S3 helper and read it back via `getObjectText` → matches.
  Clean up the inserted user at the end (or rely on the next run's DB reset).

- [ ] **Step 2: Run the e2e suite.** `sh -c 'cd <repo-root> && /Users/jeremy/.bun/bin/bun run test:e2e'` → the smoke test PASSES (MinIO boots, DB resets+migrates, all assertions pass).

- [ ] **Step 3: Commit.**

```bash
git -C <repo-root> add tests/e2e/smoke.e2e.test.ts
git -C <repo-root> commit -m "test(api): add e2e smoke test proving DB+MinIO+auth harness" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `bun run test:e2e` → smoke test passes.
- [ ] `bun run test` (unit suite) → still 450 passed / 6 failed (pre-existing payment failures), no e2e files picked up.
- [ ] `bun run typecheck` → exit 0.

## Done criteria

- A `padmakara_test` database is created and migrated by the e2e harness.
- MinIO boots and serves S3 for the e2e suite.
- `POST /api/test/token` mints JWTs outside production and is absent in production.
- The smoke test proves the full chain works.
- Branch `feature/e2e-foundation` ready; WS1-B (seeding + access-control e2e) builds on this.

## Risks / notes

- If `minio` cannot be installed (no Homebrew, network), Task 3 is blocked — report it; do not fake the helper.
- `drizzle-kit migrate` is CLI-only; it is invoked as a subprocess with `DATABASE_URL` overridden.
- The e2e suite runs single-worker because it shares one database.
