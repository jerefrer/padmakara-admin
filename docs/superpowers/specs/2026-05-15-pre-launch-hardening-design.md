# Pre-launch hardening & content tooling — design spec

**Date:** 2026-05-15
**Status:** Draft — awaiting user review
**Scope:** `padmakara-api` (Hono/Drizzle/Bun) and `padmakara-app` (React Native/Expo)

## 1. Context & goal

The Padmakara app is feature-complete enough to plan a production launch. Before launch, four pieces of work remain. They are independent and were surfaced by a four-domain audit (payment, admin tooling, test infrastructure, security):

- The app will launch with an **empty production database**; a full-time colleague will add historical events one by one through the admin UI.
- The payment system (Easypay) is ~70% built but unverified — **explicitly out of scope here** (separate decision pending on whether launch requires it).
- A security audit found 2 critical and several high/medium issues.
- The team wants a comprehensive end-to-end test suite.

Goal of this spec: define WS0–WS3 precisely enough to drive an implementation plan.

## 2. Scope decomposition

| # | Workstream | Repos | Branch |
|---|-----------|-------|--------|
| WS0 | Critical security fixes (C1, C2) | api | `fix/critical-security` |
| WS1 | E2e test foundation + comprehensive suite | api + app | `feature/e2e-foundation` |
| WS2 | Security hardening (HIGH/MEDIUM findings) | api + app | `feature/security-hardening` |
| WS3 | Admin content tooling | api (`admin/`) | `feature/admin-content-tooling` |

## 3. WS0 — Critical security fixes

Two isolated bug fixes. No design decisions; the audit specifies them exactly.

### C1 — Read-along webhook signature check crashes instead of rejecting
- **File:** `padmakara-api/src/routes/webhooks.ts:34`
- **Problem:** `crypto.timingSafeEqual` throws `RangeError` when the two buffers differ in length. A wrong-length `X-Webhook-Signature` produces a 500 crash, and the rejection path is not robust.
- **Fix:** Compare buffer lengths first; only call `timingSafeEqual` on equal-length buffers — mirror the correct `/bunny` handler at `webhooks.ts:111-113`. Defensively wrap `Buffer.from(signature)`.
- **Test:** Webhook returns `401` (not 500/crash) for empty, short, and wrong-length signatures; still accepts a valid signature.

### C2 — `AppError.internal` does not exist
- **File:** `padmakara-api/src/lib/errors.ts`
- **Problem:** `AppError.internal(...)` is called in `media.ts:249,289,460`, `payment.ts:38`, `admin/events.ts:299,345,358` but the static method is undefined → `TypeError` crash on every error path that uses it (transcript serving, HLS proxy, payments, AI translation).
- **Fix:** Add `static internal(message = "Internal server error")` returning `new AppError(500, message, "INTERNAL_ERROR")`.
- **Test:** A route path that triggers `AppError.internal` returns a clean `500` with the standard error envelope, not a `TypeError`.

## 4. WS1 — E2e test foundation + comprehensive suite

User chose the **comprehensive** scope: foundation plus full coverage of stable user flows.

### 4.1 Test database
- Dedicated local Postgres database `padmakara_test` (Postgres already running on `:5432`).
- A setup routine resets the schema and applies all migrations from `src/db/migrations/` before the suite runs.
- Configured via a test-only `DATABASE_URL` (`.env.test` or an env override). Never points at `padmakara` / `padmakara_dev`.

### 4.2 Seeding
- A deterministic, idempotent seed module (`padmakara-api/tests/e2e/seed.ts`) builds a fixed dataset:
  - 2 retreat groups.
  - One event per audience type: `free-anyone`, `free-subscribers`, `retreat-group-members`, `event-participants`, `available-on-request-only`, `received-initiation`.
  - Each event: ≥1 session, ≥2 tracks, ≥1 PDF transcript.
  - Known IDs/slugs exported as constants so tests never hardcode magic numbers (replaces the current `audio-resume.spec.ts` hardcoded prod IDs).

### 4.3 Test users
Seeded accounts spanning the access matrix, each with a stable known credential:
- anonymous (no account), free subscriber, retreat-group member, event participant, on-request-granted user, admin.

### 4.4 Non-interactive auth
- An env-gated route `POST /api/test/token` issues a JWT for a given seeded user. Mounted **only when `NODE_ENV !== "production"`** and refuses to load otherwise.
- API e2e tests obtain tokens directly via the JWT signing service (no HTTP round-trip).
- Playwright web e2e uses the route to populate `storageState`, replacing the manual magic-link round-trip in `e2e/auth.setup.ts`.

### 4.5 S3 for tests
- A dedicated test bucket (or a `e2e-fixtures/` prefix on a test bucket) seeded with small fixture media: a few short MP3s and one sample PDF, with S3 keys matching the seeded tracks/transcripts.
- The seed module uploads fixtures if absent.
- (MinIO/LocalStack noted as a future CI option; not in this round.)

### 4.6 API e2e against real Postgres
- New directory `padmakara-api/tests/e2e/`. Reuses the `app.fetch` helper pattern from `tests/helpers.ts`, but the DB is the real `padmakara_test` instead of the `vi.mock`'d module.
- Covers: the 6-audience **access-control matrix** verified against real Drizzle queries; content/event/session/track read endpoints; download/ZIP endpoints; sync endpoints.
- This closes the documented mocked-DB blind spot (migration/query drift).

### 4.7 Web UI e2e (Playwright)
Extends `padmakara-app/e2e/`. Comprehensive coverage of stable flows against the Expo web build + real test API:
- Core read journey: login → groups → event → session → play a track → open transcript.
- Bookmarks (create, list, jump-to).
- Downloads (request, ZIP retrieval).
- Offline playback (cached track plays without network).
- Search.
- The existing `audio-resume.spec.ts` regression is retained and re-pointed at seeded IDs.

### 4.8 Stable selectors
- Add `testID` / `accessibilityLabel` to track rows, navigation cards, and audio-player controls in `padmakara-app` so Playwright stops scraping `div[tabindex]` + `textContent`.

## 5. WS2 — Security hardening

Addresses the HIGH/MEDIUM audit findings. Lands **after** WS1 so the e2e net catches regressions. Two changes intentionally alter behavior and will require updating ~2–3 e2e assertions (noted inline).

### HIGH
- **H1 — Rate limiting.** Add `hono-rate-limiter` (per-IP and per-email) on all `/auth/*` POST endpoints: `request-magic-link`, `request-approval`, `login`, `device/discover`. Unify the `request-magic-link` response so it no longer distinguishes known vs. unknown email (account-enumeration oracle). *Behavior change — e2e assertion update.*
- **H2 — Anonymous ZIP download IDOR.** Re-verify the event is still public at download time in `downloads.ts`; invalidate anonymous download requests when an event's audience changes. Decision logged in `DECISIONS.md`.
- **H3 — Secret startup guards.** In `config.ts`, when `NODE_ENV === "production"`, hard-fail at startup if `JWT_SECRET` equals the dev default or is <32 chars; same for `READ_ALONG_WEBHOOK_SECRET`. Assert `NODE_ENV` is explicitly set.
- **H4 — Security headers.** `app.use("*", secureHeaders())` from `hono/secure-headers` in `src/index.ts`, tuned to allow the Easypay CDN script on the checkout page only.

### MEDIUM
- **M1 — Refresh token lifetime.** Reduce `refreshTokenExpiry` from `365d` to `60d`.
- **M2 — Secure token storage (app).** Move `auth_token` / `refresh_token` from `AsyncStorage` to `expo-secure-store` on native. **Transparent migration:** on launch, if a token exists in `AsyncStorage`, move it to SecureStore and clear the old copy — no forced re-login. Web keeps `localStorage` (CSP now present via H4).
- **M3 — Drop `?token=` JWT.** Remove query-parameter JWT acceptance from `optionalAuthMiddleware`; rely on the existing MAT system for HLS/iframe cases. *Behavior change — verify no e2e depends on it.*
- **M4 — Admin upload validation.** Add Zod schemas to `admin/upload.ts` `presign-transcript` and `infer-sessions`; reject `..`, `/`, and control chars in `filename`.
- **M5 — Presigned-URL cache.** Scope the `s3.ts` cache to image keys only (its original intent); do not cache audio/transcript keys. Document.
- **M6 — Legacy magic-link endpoint.** Remove the user-auto-creation branch from `/verify-magic-link` (or remove the endpoint if unused).

## 6. WS3 — Admin content tooling

Makes the admin usable for the colleague entering historical events one by one. All work in `padmakara-api/admin/` plus minor admin-route additions. User chose to **include the AI textarea** this round.

### 6.1 PDF transcript upload (highest priority — current blocker)
- Backend route `POST /api/admin/upload/presign-transcript` already exists.
- Add a transcript upload affordance to `EventCreate` and `EventEdit` (`admin/src/resources/events.tsx`), reusing `uploadManager` for presign + direct-to-S3 PUT.
- Transcripts attach to sessions/events per the existing `transcripts` model.

### 6.2 Add sessions/tracks to an existing event
- Add a `TrackDropZone` to `EventEdit` that creates new sessions/tracks on an existing event and uploads them via `uploadManager` — removing the current delete-and-recreate friction.

### 6.3 Rename-preview table
- After a folder is dropped, show an editable table: each row = original filename → proposed track title / track number / speaker / language flags.
- The colleague edits rows; nothing is created or uploaded until commit.
- For new events the rename is purely client-side (the edited filename feeds `buildTrackS3Key` / the presign call). No S3 rename needed.

### 6.4 AI textarea for bulk operations
- New admin route mirroring the existing `POST /:id/translate-themes` pattern in `admin/events.ts` (Anthropic SDK already integrated, `ANTHROPIC_API_KEY` present).
- A textarea on the rename-preview table: the colleague types an instruction ("number these sequentially", "strip the date prefix from titles", …); the endpoint sends the current parsed rows + instruction to Claude and returns a JSON mapping.
- The mapping is applied **into the editable table for review** — the AI never mutates S3/DB directly. The colleague reviews, then commits.

### 6.5 Documentation fix
- The S3 path convention documented in `CLAUDE.md` (`YYYY.MM.DD - GROUP - PLACE - TEACHER/…`) does not match the code (`events/{eventCode}/{filename}`). Correct `CLAUDE.md` so the colleague is not misled.

## 7. Sequencing, branches & worktrees

- **Phase 1 (sequential):** WS0 on `fix/critical-security` (small, merge fast) → WS1 on `feature/e2e-foundation`. WS1 establishes the regression net.
- **Phase 2 (parallel, two worktrees branched off the updated `main`):** WS2 `feature/security-hardening` ‖ WS3 `feature/admin-content-tooling`. They touch disjoint files (`src/index.ts`/`config.ts`/`auth.ts` vs `admin/` + `src/routes/admin/`) → clean merges.
- Worktree node_modules: `padmakara-api` worktree → `bun install` (fast, Bun global cache + APFS clonefile). `padmakara-app` worktree → `cp -cR padmakara-app/node_modules <worktree>/node_modules` (instant APFS copy-on-write).
- Execution: subagent-driven per the implementation plan from `writing-plans`.

## 8. Decisions made

- Test DB = local `padmakara_test` (Testcontainers deferred to CI).
- Non-interactive test auth = env-gated `POST /api/test/token`, disabled in production.
- `expo-secure-store` migration is transparent — no forced re-login.
- E2e scope = comprehensive (all stable user flows) — user decision.
- AI textarea included in WS3 — user decision.
- Refresh token lifetime → 60 days.

## 9. Out of scope

- Payment / Easypay completion (separate decision pending on launch dependency).
- Apple Reader App compliance pass on the subscription screen (tied to payment).
- Native (iOS/Android) e2e via Maestro — deferred until the web suite is stable.
- Full line-by-line security review of every admin CRUD route (LOW findings, post-launch).
- Server-side S3 object renaming for already-uploaded events.

## 10. Testing strategy

- WS0: targeted unit/route tests for each fix.
- WS1: is itself the test infrastructure; its deliverables are the tests.
- WS2: each finding gets a regression test (rate-limit returns 429, startup guard fails on bad secret, headers present, IDOR re-check, etc.). Existing suite must stay green except the 2–3 intentionally updated assertions.
- WS3: route tests for new/changed admin endpoints; manual verification of the upload UI flows.

## 11. Risks

- WS1 is the largest workstream; S3 fixture setup and stable selectors are the fiddly parts.
- WS2 H1 (rate limiting) is the highest-effort security item — per-email keying and not breaking legitimate retry behavior.
- WS3 AI textarea depends on the rename-preview table existing first (6.3 before 6.4).
- Worktree parallelism assumes WS2/WS3 do not change shared dependencies; if either needs a new dependency that the other also touches, coordinate the lockfile.
