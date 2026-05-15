# WS1-B — Seeding + Access-Control API E2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Build a deterministic seed dataset (groups, the 6 audience types, events/sessions/tracks/transcripts, test users across the access matrix, fixture media in MinIO) and an API e2e suite that verifies the audience-based access-control matrix and core content reads against the real `padmakara_test` database.

**Architecture:** Builds on WS1-A's harness (branch `feature/e2e-foundation`). A `seedTestData()` module populates the test DB and MinIO; `global-setup.ts` calls it after DB reset + MinIO start. E2e tests authenticate seeded users via the `POST /api/test/token` route and assert real query behaviour.

**Tech Stack:** Hono, Bun, Drizzle, Vitest, `@aws-sdk/client-s3`, MinIO.

**Spec:** `docs/superpowers/specs/2026-05-15-pre-launch-hardening-design.md` (§4.2, 4.3, 4.6).

**Branch:** continue on `feature/e2e-foundation` (do NOT create a new branch; WS1-A is already here).

## Conventions

- Repo root: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api`. zoxide → use `sh -c 'cd <abs> && <cmd>'`.
- e2e run: `sh -c 'cd <root> && /Users/jeremy/.bun/bin/bun run test:e2e 2>&1 | tail -30'`
- Conventional Commits; messages end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Never `git add` the untracked `src/scripts/fix-misattributed-pt-tracks.ts` — explicit paths only.
- **Read the actual schema** in `src/db/schema/*.ts` for exact table-export names, column names, and NOT-NULL constraints — do not guess. Read `src/services/access.ts` for the exact access logic.

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `tests/e2e/support/fixtures.ts` | Constants: known seed identities, event handles, fixture media keys | Create |
| `tests/e2e/support/seed.ts` | `seedTestData()` — populate test DB + MinIO | Create |
| `tests/e2e/support/auth.ts` | `tokenForUser()` — JWT for a seeded user | Create |
| `tests/e2e/support/global-setup.ts` | Call `seedTestData()` after DB+MinIO up | Modify |
| `tests/e2e/access-control.e2e.test.ts` | 6-audience access matrix | Create |
| `tests/e2e/content.e2e.test.ts` | Content/session/track/search reads | Create |

---

## Task 1: Seed fixtures + dataset module

**Why:** Every e2e test needs a fixed, known dataset. Hardcoding IDs in tests is forbidden — handles come from one module.

**Files:** Create `tests/e2e/support/fixtures.ts`, `tests/e2e/support/seed.ts`.

- [ ] **Step 1: Read the schema.** Read `src/db/schema/users.ts`, `retreat-groups.ts`, `retreats.ts`, `sessions.ts`, `tracks.ts`, `transcripts.ts`, `audiences.ts`, and the join tables (`retreat_group_retreats`/event-group link, `user_group_memberships`, `user_retreat_attendance` — exact file/table names per the schema). Note every NOT-NULL column and its type for: audiences, retreatGroups, events (`retreats`), sessions, tracks, transcripts, users, group memberships, event attendance.

- [ ] **Step 2: Write `fixtures.ts`.** Export plain constants describing the intended dataset — NOT DB ids (those are assigned on insert), but stable business keys and the test-user identities:

```typescript
// The 6 audience slugs the access matrix exercises.
export const AUDIENCE_SLUGS = {
  freeAnyone: "free-anyone",
  freeSubscribers: "free-subscribers",
  retreatGroupMembers: "retreat-group-members",
  eventParticipants: "event-participants",
  availableOnRequest: "available-on-request-only",
  receivedInitiation: "received-initiation",
} as const;

// Stable eventCode per audience-type event.
export const EVENT_CODES = {
  anyone: "E2E-ANYONE",
  subscribers: "E2E-SUBS",
  groupMembers: "E2E-GROUP",
  participants: "E2E-PART",
  onRequest: "E2E-REQ",
  initiation: "E2E-INIT",
} as const;

// Test users — emails are the stable handle.
export const TEST_USERS = {
  nosub:       { email: "e2e-nosub@example.com",       role: "user" as const },
  subscriber:  { email: "e2e-subscriber@example.com",  role: "user" as const },
  groupMember: { email: "e2e-groupmember@example.com", role: "user" as const },
  participant: { email: "e2e-participant@example.com", role: "user" as const },
  granted:     { email: "e2e-granted@example.com",     role: "user" as const },
  admin:       { email: "e2e-admin@example.com",       role: "admin" as const },
} as const;

export const TEST_GROUP_SLUG = "e2e-group-alpha";
```

- [ ] **Step 3: Write `seed.ts`.** Export `async function seedTestData(): Promise<SeededData>`. It runs against the real `db` (import from `src/db/index.ts`). It must be idempotent-friendly (the DB is freshly reset before it runs, so plain inserts are fine). It:
  1. **Audiences:** ensure a row exists for each of the 6 `AUDIENCE_SLUGS` (insert if absent — the `audiences` table may already be seeded by migrations; check first with a select, insert only missing ones).
  2. **Group:** insert one `retreatGroups` row with slug `TEST_GROUP_SLUG`.
  3. **Events:** insert 6 `retreats` (events), one per `EVENT_CODES`, each `status: "published"`, each with the matching `audienceId`. Link the `groupMembers` event to the test group via the event-group join table.
  4. **Sessions + tracks + transcripts:** for each event, insert 1 session, 2 tracks (with `s3Key` values under `events/<eventCode>/...`), and 1 transcript (`s3Key` under `events/<eventCode>/transcripts/...`). Use the fixture media keys (Task 2).
  5. **Users:** insert the 6 `TEST_USERS` rows. Set `isActive`/`isVerified` true. `subscriptionStatus`: `none` for `nosub` and `granted`; `active` (with `subscriptionExpiresAt` ~1 year out) for `subscriber`, `groupMember`, `participant`. `role` per fixtures (`admin` is `admin`).
  6. **Memberships:** `groupMember` user → membership row in the test group.
  7. **Attendance:** `participant` user → `user_retreat_attendance` row for the `participants` event. `granted` user → attendance rows for the `onRequest` AND `initiation` events.
  8. Return a `SeededData` object containing the resolved DB ids needed by tests: `{ users: { nosub: {id,email,role}, ... }, events: { anyone: {id,eventCode}, ... }, groupId, sessionIds, trackIds, transcriptIds }`.
  Define and export the `SeededData` type. Keep `seed.ts` focused; if it grows past ~250 lines, that is acceptable for a seed module but keep it well-sectioned with comments.

- [ ] **Step 4: Typecheck.** `bun run typecheck` → exit 0. (Cannot fully run yet — `seedTestData` is wired in Task 3.)

- [ ] **Step 5: Commit.** `git add tests/e2e/support/fixtures.ts tests/e2e/support/seed.ts` → commit `test(api): add e2e seed dataset and fixtures` (+ Co-Authored-By footer).

---

## Task 2: Fixture media + wire seeding into global setup

**Why:** Seeded tracks/transcripts reference S3 keys; MinIO must hold matching objects. And `seedTestData()` must run as part of harness startup.

**Files:** Create `tests/e2e/support/fixtures/` media files (or generate them in code). Modify `tests/e2e/support/seed.ts` (or a small `media.ts`) and `tests/e2e/support/global-setup.ts`.

- [ ] **Step 1: Fixture media.** The e2e suite needs small placeholder media. Simplest robust approach: generate them in code rather than committing binaries — a tiny valid MP3 is hard to synthesize, so instead **upload small placeholder byte buffers** under the track/transcript S3 keys (the API e2e tests only need the objects to EXIST and be fetchable as presigned URLs; they do not decode audio). Add an `uploadFixtureMedia(seeded: SeededData)` step that, for every seeded track `s3Key` and transcript `s3Key`, calls `putObject(key, Buffer.from("e2e-fixture"), "audio/mpeg" | "application/pdf")`. (Real audio playback is exercised by the Playwright suite in WS1-C, not here.)

- [ ] **Step 2: Wire into `global-setup.ts`.** After `resetTestDatabase()` and `startMinio()` succeed, call `seedTestData()` then `uploadFixtureMedia(...)`. Order: DB reset → MinIO start → seed DB → upload fixture media. Keep the existing teardown (stop MinIO). Surface seed errors clearly.

- [ ] **Step 3: Run the e2e suite.** `bun run test:e2e` → the existing smoke test still passes AND global setup now seeds without error. (If the smoke test's own inserted user collides with seeded data, adjust the smoke test's email to something clearly distinct.)

- [ ] **Step 4: Commit.** Commit the media wiring → `test(api): seed test data and fixture media in e2e global setup`.

---

## Task 3: E2e auth helper

**Why:** Tests authenticate as seeded users without the magic-link flow.

**Files:** Create `tests/e2e/support/auth.ts`.

- [ ] **Step 1: Write `auth.ts`.** Export `async function tokenForUser(user: { id: number; email: string; role: string }): Promise<string>`. It POSTs to `/api/test/token` via the `testJson` helper (`{ userId: user.id, email: user.email, role: user.role }`) and returns `body.token`. Also export a convenience `authHeader(token: string)` → `{ Authorization: \`Bearer ${token}\` }`. Keep it tiny and focused.

- [ ] **Step 2: Typecheck → exit 0. Commit.** → `test(api): add e2e auth helper for seeded users`.

---

## Task 4: Access-control matrix e2e test

**Why:** The 6-audience access model is security-critical and was only unit-tested with a mocked DB. This verifies it against real Drizzle queries.

**Files:** Create `tests/e2e/access-control.e2e.test.ts`.

- [ ] **Step 1: Confirm the access rules.** Read `src/services/access.ts`. The expected visibility matrix (verify against the code; adjust if the code differs):

| User | Can access events with audience |
|------|--------------------------------|
| anonymous (no token) | `free-anyone` only (via public endpoints) |
| `nosub` (account, no subscription) | `free-anyone` |
| `subscriber` (active sub) | `free-anyone`, `free-subscribers` |
| `groupMember` (active sub + group member) | `free-anyone`, `free-subscribers`, `retreat-group-members` |
| `participant` (active sub + attendance) | `free-anyone`, `free-subscribers`, `event-participants` |
| `granted` (no sub + attendance on request/initiation events) | `free-anyone`, `available-on-request-only`, `received-initiation` |
| `admin` | all 6 |

- [ ] **Step 2: Write the test.** `tests/e2e/access-control.e2e.test.ts`:
  - Import `seedTestData`'s result — since `global-setup` already seeded, the test re-derives handles by querying the real `db` for the test users/events by their stable `email`/`eventCode` from `fixtures.ts` (do NOT re-seed). Put this lookup in a `beforeAll`.
  - For each authenticated user: get a token via `tokenForUser`, call `GET /api/events` with the auth header, and assert the returned event set's `eventCode`s exactly equal the expected set from the matrix.
  - For each user × each event: `GET /api/events/:id` → expect `200` if the event is in the user's allowed set, `403` (or `404` — match what `access.ts`/the route actually returns; assert the actual deny behaviour) if not.
  - Anonymous: `GET /api/events/public` returns only the `free-anyone` event; `GET /api/events/public/:id` on a non-public event denies.
  - Structure with clear `describe`/`it` names (`it("subscriber sees free-anyone and free-subscribers events")`).

- [ ] **Step 3: Run.** `bun run test:e2e` → access-control suite passes. If an assertion fails because the real behaviour differs from the matrix above, investigate `access.ts` — the REAL behaviour is the source of truth; correct the test's expectation to match verified real behaviour, and note the discrepancy in the commit body.

- [ ] **Step 4: Commit.** → `test(api): add e2e access-control matrix coverage (6 audience types)`.

---

## Task 5: Content + search read e2e

**Why:** Verify the core content-read endpoints work end to end against the real DB.

**Files:** Create `tests/e2e/content.e2e.test.ts`.

- [ ] **Step 1: Write the test.** `tests/e2e/content.e2e.test.ts`, authenticating as the `subscriber` user (or `admin` where broad visibility is needed):
  - `GET /api/events/:id` for an accessible event → 200, body has the event with its `sessions` and each session's `tracks` (assert counts match the seed: 1 session, 2 tracks).
  - `GET /api/events/sessions/:sessionId` → 200 with tracks.
  - `GET /api/events/tracks/:trackId` → 200.
  - `GET /api/media/audio/:trackId` with auth → 200, body contains a presigned URL string pointing at the MinIO endpoint.
  - `GET /api/content/progress` → 200 (empty array initially); `POST` a progress row then `GET` again → the row is present.
  - `GET /api/search?q=<a word from a seeded event title>` → 200, returns the seeded event.
  - Verify exact endpoint paths and response shapes by reading `src/routes/events.ts`, `content.ts`, `media.ts`, `search.ts`.

- [ ] **Step 2: Run.** `bun run test:e2e` → all e2e suites green.

- [ ] **Step 3: Commit.** → `test(api): add e2e content and search read coverage`.

---

## Final verification

- [ ] `bun run test:e2e` → smoke + access-control + content suites all pass.
- [ ] `bun run test` (unit) → still 452 passed / 6 failed (pre-existing), no e2e files.
- [ ] `bun run typecheck` → exit 0.

## Done criteria

- A deterministic seed dataset exists and is applied by the e2e harness.
- The 6-audience access-control matrix is verified against the real database.
- Core content/session/track/media/search reads are covered by real-DB e2e tests.
- Branch `feature/e2e-foundation` ready for WS1-C (frontend testIDs + Playwright).

## Notes / risks

- If the real access behaviour diverges from the matrix in Task 4, the verified real behaviour wins — update the test and flag it; do not force the code to match a guessed matrix.
- The `audiences` table may be pre-populated by migrations; the seed must check before inserting to avoid unique-constraint errors on slug.
