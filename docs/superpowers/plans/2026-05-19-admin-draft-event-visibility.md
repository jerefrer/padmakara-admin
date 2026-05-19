# Admin Draft Event Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins/superadmins see `draft` events in the app; normal users and guests see only `published`; `archived` stays hidden from everyone.

**Architecture:** Make the central `checkEventAccess()` in `padmakara-api` status-aware so every content endpoint that funnels through it is gated at once. Widen the SQL status filter on list endpoints for admins, give the public endpoints optional auth, and guard the three `content.ts` write endpoints that bypass `checkEventAccess`. On the frontend, add a localized `<DraftBadge />` rendered wherever `gathering.status === 'draft'`.

**Tech Stack:** Backend — Bun, Hono, Drizzle ORM, Zod, Vitest. Frontend — React Native / Expo, TypeScript, Jest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-19-admin-draft-event-visibility-design.md`

**Worktrees (work happens here):**
- API: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.worktrees/admin-draft-event-visibility`
- App: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app/.worktrees/admin-draft-event-visibility`

Both are on branch `feature/admin-draft-event-visibility`.

**Commands:**
- API tests (all): `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'`
- API tests (one file): append the file path, e.g. `... vitest run tests/services/access.test.ts`
- API typecheck: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun run typecheck'`
- App tests: `sh -c 'cd <APP-worktree> && npm test'`
- App lint: `sh -c 'cd <APP-worktree> && npm run lint'`

`cd` must go through `sh -c` because the user's zoxide hijacks bare `cd`.

---

## File Structure

**Backend (`padmakara-api`):**
- `src/services/access.ts` — Modify: add `eventStatusVisibleTo()`, `status` on `EventForAccess`, `STATUS_HIDDEN` reason, status gate in `checkEventAccess`.
- `src/routes/events.ts` — Modify: rework `requireEventAccess`; widen `GET /api/events` admin filter; optional auth on the three public endpoints.
- `src/routes/groups.ts` — Modify: role-aware filter on `GET /api/groups/:id/events`.
- `src/routes/content.ts` — Modify: status guard on the three POST endpoints.
- `src/routes/media.ts` — Modify: map `STATUS_HIDDEN` denials to 404.
- `tests/services/access.test.ts` — Create or extend.
- `tests/routes/events.test.ts`, `tests/routes/groups.test.ts`, `tests/routes/content.test.ts` — Create or extend.

**Frontend (`padmakara-app`):**
- `components/DraftBadge.tsx` — Create.
- `components/DraftBadge.test.tsx` — Create.
- `locales/en.json`, `locales/pt.json` — Modify: add `common.draft`.
- `app/(tabs)/(groups)/index.tsx` — Modify: badge in `FeaturedEventCard` + `RecentEventCard`.
- `app/(tabs)/_events/index.tsx` — Modify: badge in `EventCard`.
- `app/(tabs)/(groups)/[groupId].tsx` — Modify: badge in the group events card.
- `app/(tabs)/(groups)/retreat/[id].tsx` — Modify: badge in `eventTitleSection`.

---

## Task 1: Status-aware `checkEventAccess`

**Files:**
- Modify: `padmakara-api/src/services/access.ts`
- Modify: `padmakara-api/src/routes/events.ts` (one line — `requireEventAccess` parameter type, see Step 5)
- Test: `padmakara-api/tests/services/access.test.ts` (create if missing)

Before editing, read `src/services/access.ts` in full to confirm the exact shapes of `EventForAccess`, `UserForAccess`, `AccessResult`, the `reason` union, and where the admin/superadmin early-return sits in `checkEventAccess`. Confirm `AUDIENCE_SLUGS.PUBLIC` equals `"free-anyone"`.

- [ ] **Step 1: Write the failing test**

Create (or append to) `tests/services/access.test.ts`. If the file exists, add only the two `describe` blocks below and reuse its imports.

```ts
import { describe, it, expect } from "vitest";
import { checkEventAccess, eventStatusVisibleTo } from "../../src/services/access.ts";

describe("eventStatusVisibleTo", () => {
  it("returns published + draft for an admin", () => {
    expect([...eventStatusVisibleTo("admin")].sort()).toEqual(["draft", "published"]);
  });

  it("returns published + draft for a superadmin", () => {
    expect([...eventStatusVisibleTo("superadmin")].sort()).toEqual(["draft", "published"]);
  });

  it("returns published only for a regular user", () => {
    expect(eventStatusVisibleTo("user")).toEqual(["published"]);
  });

  it("returns published only for an unauthenticated caller", () => {
    expect(eventStatusVisibleTo(null)).toEqual(["published"]);
    expect(eventStatusVisibleTo(undefined)).toEqual(["published"]);
  });
});

describe("checkEventAccess — status gate", () => {
  const publicEvent = (status: string) => ({
    id: 1,
    status,
    audienceId: 1,
    audience: { slug: "free-anyone" },
  });
  const admin = { id: 1, role: "admin", subscriptionStatus: "none", subscriptionExpiresAt: null };
  const regular = { id: 2, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null };

  it("allows an admin to access a draft event", async () => {
    const r = await checkEventAccess(admin, publicEvent("draft"));
    expect(r.allowed).toBe(true);
  });

  it("hides a draft event from a regular user", async () => {
    const r = await checkEventAccess(regular, publicEvent("draft"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("STATUS_HIDDEN");
  });

  it("hides a draft event from an unauthenticated caller", async () => {
    const r = await checkEventAccess(null, publicEvent("draft"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("STATUS_HIDDEN");
  });

  it("hides an archived event even from an admin", async () => {
    const r = await checkEventAccess(admin, publicEvent("archived"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("STATUS_HIDDEN");
  });

  it("still allows a regular user to access a published public event", async () => {
    const r = await checkEventAccess(regular, publicEvent("published"));
    expect(r.allowed).toBe(true);
  });
});
```

If the test object shapes (`UserForAccess`, `EventForAccess`) differ from the file, adjust the literals to match — keep the assertions identical.

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/access.test.ts'`
Expected: FAIL — `eventStatusVisibleTo` is not exported / `STATUS_HIDDEN` never returned.

- [ ] **Step 3: Implement the status gate**

In `src/services/access.ts`:

1. Add `status: string;` to the `EventForAccess` interface.
2. Add `"STATUS_HIDDEN"` to the `AccessResult.reason` union type.
3. Add the exported helper near the top of the module:

```ts
/**
 * Event statuses a caller of the given role may see in the app.
 * Admins/superadmins see drafts; everyone else (incl. unauthenticated) sees
 * only published. `archived` is never visible in the app.
 */
export function eventStatusVisibleTo(role: string | null | undefined): string[] {
  return role === "admin" || role === "superadmin"
    ? ["published", "draft"]
    : ["published"];
}
```

4. In `checkEventAccess`, **before** the admin/superadmin early-return and before any audience logic, add the status gate:

```ts
if (!eventStatusVisibleTo(user?.role).includes(event.status)) {
  return { allowed: false, reason: "STATUS_HIDDEN" };
}
```

The order matters: the status gate runs first, so an admin is still blocked from `archived`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/access.test.ts'`
Expected: PASS — all 9 cases.

- [ ] **Step 5: Typecheck and fix the one broken caller**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun run typecheck'`

Making `EventForAccess.status` required surfaces exactly one type error: `requireEventAccess` in `src/routes/events.ts` declares its `event` parameter with an inline type that omits `status`. Fix it minimally — add `status: string` to that inline parameter type (so it reads e.g. `event: { id: number; status: string; audience?: { slug: string } | null }`). Do **not** change the function body; the behavioral rework happens in Task 2.

All other callers pass event rows whose Drizzle-inferred type already includes `status`, so no further fixes are needed. Re-run typecheck — expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C <API-worktree> add src/services/access.ts src/routes/events.ts tests/services/access.test.ts
git -C <API-worktree> commit -m "feat(access): make checkEventAccess status-aware

Admins see draft+published events, others see published only; archived
is hidden from everyone. Adds eventStatusVisibleTo() and a STATUS_HIDDEN
denial reason.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `requireEventAccess` enforces status (404 for hidden events)

**Files:**
- Modify: `padmakara-api/src/routes/events.ts` (the `requireEventAccess` helper, ~lines 224-257)
- Test: `padmakara-api/tests/routes/events.test.ts` (create or extend)

Read `requireEventAccess` and `GET /api/events/:id` in full first. Note that `requireEventAccess` currently early-returns for admins without calling `checkEventAccess` — that early-return must be removed so the status gate also applies to admins (archived → 404).

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/events.test.ts`. Follow the existing db-mock pattern in that file (or in `tests/routes/health.test.ts`): `vi.mock("../../src/db/index.ts", ...)`. The test issues `GET /api/events/:id` against the Hono app with a mocked draft event and a regular-user JWT, and expects 404.

```ts
describe("GET /api/events/:id — draft visibility", () => {
  it("returns 404 when a regular user requests a draft event", async () => {
    // Arrange: mock db.query.events.findFirst to return a draft event
    // with a public audience; authenticate as a role:"user" caller.
    // Act: GET /api/events/<id> with that user's bearer token.
    // Assert: response status is 404.
    expect(res.status).toBe(404);
  });

  it("returns 200 when an admin requests a draft event", async () => {
    // Same draft event; authenticate as role:"admin".
    // Assert: response status is 200 and the body has the event id.
    expect(res.status).toBe(200);
  });
});
```

Fill the Arrange/Act bodies using the concrete mock + request helpers already used by other tests in this file. Keep the two `expect` assertions exactly as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: FAIL — the regular-user case currently returns 200.

- [ ] **Step 3: Rework `requireEventAccess`**

Replace the body of `requireEventAccess` so it always delegates to `checkEventAccess` and maps the result. Widen its `event` parameter type to include `status: string`.

```ts
async function requireEventAccess(
  userId: number,
  role: string,
  event: { id: number; status: string; audience?: { slug: string } | null },
) {
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!fullUser) throw AppError.unauthorized("User not found");

  const result = await checkEventAccess(
    {
      id: fullUser.id,
      role: fullUser.role,
      subscriptionStatus: fullUser.subscriptionStatus,
      subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
    },
    event,
  );

  if (result.allowed) return;
  if (result.reason === "STATUS_HIDDEN") {
    throw AppError.notFound("Event not found");
  }
  if (result.reason === "AUTH_REQUIRED") {
    throw AppError.unauthorized("Authentication required");
  }
  throw AppError.forbidden("Access denied to this event");
}
```

Keep the existing forbidden message/reason wording if the current code passes a more specific string — only the `STATUS_HIDDEN` branch and the removal of the admin early-return are required changes. `checkEventAccess` already returns `{ allowed: true }` for admins after the status gate, so admins keep full audience access.

Confirm every `requireEventAccess(...)` call site passes an event object that includes `status` (the event rows from `db.query.events.findFirst` already carry it — no query change needed, only the parameter type widened).

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: PASS.

- [ ] **Step 5: Full API test run + typecheck**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` then `... bun run typecheck`.
Expected: all green. If a prior test asserted that a non-admin could open a draft event via sessions/tracks, that test encoded the old bug — update it to expect 404 and note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git -C <API-worktree> add src/routes/events.ts tests/routes/events.test.ts
git -C <API-worktree> commit -m "feat(events): enforce event status in requireEventAccess

requireEventAccess now always runs checkEventAccess (no admin bypass), so
a draft/archived event returns 404 for non-admins and archived returns
404 for everyone. Covers /events/:id, /sessions/:id, /tracks/:id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Admins get drafts from `GET /api/events`

**Files:**
- Modify: `padmakara-api/src/routes/events.ts` (the `GET "/"` handler, ~lines 329-374)
- Test: `padmakara-api/tests/routes/events.test.ts`

Read the `GET "/"` handler. The admin branch currently filters `eq(events.status, "published")`.

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/events.test.ts`:

```ts
describe("GET /api/events — admin draft list", () => {
  it("includes draft events for an admin", async () => {
    // Arrange: mock db.query.events.findMany to assert it is called with a
    // status filter covering published+draft; return one draft + one published.
    // Authenticate as role:"admin".
    // Assert: response is 200 and contains the draft event's id.
    expect(res.status).toBe(200);
    expect(ids).toContain(draftEventId);
  });
});
```

The most robust assertion: spy on `db.query.events.findMany`, return both a draft and a published event for the admin call, and assert the response body contains the draft id. Fill Arrange/Act with the file's existing helpers; keep the two assertions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: FAIL if the handler hard-filters to `published` (depending on how the mock is shaped) — at minimum the new test must be red before Step 3.

- [ ] **Step 3: Widen the admin filter**

In the admin branch of `GET "/"`, change the `where` from:

```ts
where: eq(events.status, "published"),
```

to:

```ts
where: inArray(events.status, ["published", "draft"]),
```

Ensure `inArray` is imported from `drizzle-orm` (add it to the existing import if absent). Leave the regular-user branch's `eq(events.status, "published")` unchanged — `checkEventAccess` would drop drafts anyway, and the SQL filter avoids fetching them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <API-worktree> add src/routes/events.ts tests/routes/events.test.ts
git -C <API-worktree> commit -m "feat(events): include draft events in GET /api/events for admins

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Optional auth on the public event endpoints

**Files:**
- Modify: `padmakara-api/src/routes/events.ts` (`GET /public`, `GET /public/:id`, `GET /featured`)
- Test: `padmakara-api/tests/routes/events.test.ts`

Read the three public handlers and confirm how optional auth is obtained elsewhere — `getOptionalUser(c)` is used in `src/routes/media.ts`. These public routes are registered without `authMiddleware`; `getOptionalUser` must work without it (it reads/verifies the bearer token if present, returns `null` otherwise). Verify this against `src/middleware/auth.ts` before relying on it; if `getOptionalUser` requires middleware, add the optional-auth middleware used by media routes to these three routes.

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/events.test.ts`:

```ts
describe("GET /api/events/public — admin sees drafts", () => {
  it("excludes draft events when called without a token", async () => {
    // Mock db.query.events.findMany; call GET /api/events/public with no
    // Authorization header. Assert the status filter is published-only
    // (no draft events in the response).
    expect(res.status).toBe(200);
    expect(ids).not.toContain(draftEventId);
  });

  it("includes draft events when called with an admin token", async () => {
    // Same endpoint, with a role:"admin" bearer token.
    expect(res.status).toBe(200);
    expect(ids).toContain(draftEventId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: FAIL — the admin-token case currently excludes drafts.

- [ ] **Step 3: Apply optional auth + status filter**

In each of the three handlers:

1. Resolve the optional caller: `const user = getOptionalUser(c);` (import `getOptionalUser` and `eventStatusVisibleTo` if not already imported — the latter from `../services/access.ts`).
2. Replace the hard-coded `eq(events.status, "published")` in the `where` with `inArray(events.status, eventStatusVisibleTo(user?.role))`.

For `GET /public` the `where` keeps the `eq(events.audienceId, publicAudience.id)` term — only the status term changes, e.g.:

```ts
where: and(
  inArray(events.status, eventStatusVisibleTo(user?.role)),
  eq(events.audienceId, publicAudience.id),
),
```

For `GET /public/:id` keep the `eq(events.id, id)` term and the existing public-audience check after the fetch. For `GET /featured` keep the `isNotNull(events.featuredAt)` term.

For a guest (no token) `eventStatusVisibleTo(undefined)` is `["published"]`, so `inArray(status, ["published"])` is behaviorally identical to today's `eq(status, "published")`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/events.test.ts'`
Expected: PASS.

- [ ] **Step 5: Full API test run + typecheck**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` then `... bun run typecheck`.
Expected: all green — existing public-endpoint tests still pass (guest behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git -C <API-worktree> add src/routes/events.ts tests/routes/events.test.ts
git -C <API-worktree> commit -m "feat(events): optional auth on public endpoints so admins see drafts

/events/public, /events/public/:id and /events/featured now read the
bearer token if present and include draft events for admins. Guest and
regular-user behavior is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Role-aware filter on `GET /api/groups/:id/events`

**Files:**
- Modify: `padmakara-api/src/routes/groups.ts` (the `GET "/:id/events"` handler)
- Test: `padmakara-api/tests/routes/groups.test.ts` (create or extend)

Read `GET "/:id/events"`. It currently filters `and(inArray(events.id, eventIds), eq(events.status, "published"))`.

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/groups.test.ts`:

```ts
describe("GET /api/groups/:id/events — draft visibility", () => {
  it("includes draft events for an admin", async () => {
    // Mock the group lookup, the event-link lookup, and
    // db.query.events.findMany; return a draft + a published event.
    // Authenticate as role:"admin".
    expect(res.status).toBe(200);
    expect(ids).toContain(draftEventId);
  });

  it("excludes draft events for a regular user", async () => {
    // Same group/links; authenticate as role:"user".
    expect(res.status).toBe(200);
    expect(ids).not.toContain(draftEventId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/groups.test.ts'`
Expected: FAIL — admin case currently excludes drafts.

- [ ] **Step 3: Make the filter role-aware**

Import `eventStatusVisibleTo` from `../services/access.ts`. Change the events `where` from:

```ts
where: and(
  inArray(events.id, eventIds),
  eq(events.status, "published"),
),
```

to:

```ts
where: and(
  inArray(events.id, eventIds),
  inArray(events.status, eventStatusVisibleTo(user.role)),
),
```

`user` is already resolved in this handler via `getUser(c)`. `filterAccessibleEvents` runs afterward and continues to apply audience rules.

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/groups.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <API-worktree> add src/routes/groups.ts tests/routes/groups.test.ts
git -C <API-worktree> commit -m "feat(groups): admins see draft events in GET /api/groups/:id/events

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Status guard on `content.ts` write endpoints

**Files:**
- Modify: `padmakara-api/src/routes/content.ts` (`POST /progress`, `POST /event-bookmarks`, `POST /track-bookmarks`)
- Test: `padmakara-api/tests/routes/content.test.ts` (create or extend)

Read the three POST handlers. None currently route through `checkEventAccess`. Each must resolve the target event's `status` and reject when it is not visible to the caller.

- [ ] **Step 1: Write the failing test**

Add to `tests/routes/content.test.ts`:

```ts
describe("content write endpoints — draft guard", () => {
  it("returns 404 when a regular user bookmarks a draft event", async () => {
    // Mock the event lookup to return a draft event; POST /api/content/event-bookmarks
    // with { eventId } as a role:"user" caller.
    expect(res.status).toBe(404);
  });

  it("allows an admin to bookmark a draft event", async () => {
    // Same draft event; role:"admin" caller.
    expect([200, 201]).toContain(res.status);
  });

  it("returns 404 when a regular user posts progress on a draft event's track", async () => {
    // Mock the track lookup so its session.event is a draft event;
    // POST /api/content/progress as a role:"user" caller.
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/content.test.ts'`
Expected: FAIL — currently these return success for a draft event.

- [ ] **Step 3: Add the status guard**

Import `eventStatusVisibleTo` from `../services/access.ts`.

For `POST /event-bookmarks`: after the event is resolved (the handler validates `data.eventId`; load the event row if it does not already), guard:

```ts
const event = await db.query.events.findFirst({
  where: eq(events.id, data.eventId),
});
if (!event || !eventStatusVisibleTo(user.role).includes(event.status)) {
  throw AppError.notFound("Event not found");
}
```

For `POST /progress` and `POST /track-bookmarks`: the handler already resolves the track. Extend that lookup to include the parent event status — `with: { session: { with: { event: true } } }` — then guard:

```ts
const status = track?.session?.event?.status;
if (!status || !eventStatusVisibleTo(user.role).includes(status)) {
  throw AppError.notFound("Track not found");
}
```

Place each guard after the input is validated and before the insert/upsert. Reuse the handler's existing `events`/`tracks` imports; add them if missing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/content.test.ts'`
Expected: PASS.

- [ ] **Step 5: Full API test run + typecheck**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` then `... bun run typecheck`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git -C <API-worktree> add src/routes/content.ts tests/routes/content.test.ts
git -C <API-worktree> commit -m "feat(content): block non-admins from writing state on draft events

Adds a status guard to POST /content/progress, /event-bookmarks and
/track-bookmarks — the three write endpoints that bypass checkEventAccess.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Map `STATUS_HIDDEN` to 404 in media routes

**Files:**
- Modify: `padmakara-api/src/routes/media.ts`
- Test: `padmakara-api/tests/routes/media.test.ts` (create or extend — optional if no media test file exists; see Step 1)

Read `src/routes/media.ts`. Each handler (`/audio/:trackId`, `/video/session/:sessionId`, `/video/session/:sessionId/download`, `/readalong/:trackId`, `/transcript/:transcriptId`) calls `checkEventAccess` and has an `if (!accessResult.allowed) { ... }` block that throws 401 for `AUTH_REQUIRED` and 403 otherwise. A `STATUS_HIDDEN` denial currently falls through to 403; it should be 404.

- [ ] **Step 1: Write the failing test**

If `tests/routes/media.test.ts` exists, add a case asserting `GET /api/media/audio/:trackId` returns 404 for a regular user when the track's event is a draft. If no media test file exists, skip the test (the behavior is already exercised end-to-end by Task 2's coverage of `requireEventAccess`); note the skip in the commit body and proceed to Step 3.

```ts
it("returns 404 for a regular user requesting audio of a draft event's track", async () => {
  // Mock getEventForTrack to return a draft event; call as role:"user".
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run the test to verify it fails (only if a test was written)**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/media.test.ts'`
Expected: FAIL with 403 instead of 404.

- [ ] **Step 3: Add the `STATUS_HIDDEN` branch**

In each `if (!accessResult.allowed) { ... }` block in `media.ts`, add a branch before the final `throw AppError.forbidden(...)`:

```ts
if (accessResult.reason === "STATUS_HIDDEN") {
  throw AppError.notFound("Not found");
}
```

Keep the existing `AUTH_REQUIRED` → `unauthorized` branch and the final `forbidden` fallback.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` then `... bun run typecheck`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git -C <API-worktree> add src/routes/media.ts tests/routes/media.test.ts
git -C <API-worktree> commit -m "feat(media): return 404 (not 403) for status-hidden events

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `<DraftBadge />` component + localization

**Files:**
- Create: `padmakara-app/components/DraftBadge.tsx`
- Create: `padmakara-app/components/DraftBadge.test.tsx`
- Modify: `padmakara-app/locales/en.json`, `padmakara-app/locales/pt.json`

Read `components/OfflineBadge.tsx` (the pattern to mirror) and `constants/colors.ts` (for `colors.saffron`). Read a slice of `locales/en.json` to confirm the `common` object's key style.

- [ ] **Step 1: Write the failing test**

Create `components/DraftBadge.test.tsx`:

```tsx
import React from "react";
import { render } from "@testing-library/react-native";
import { DraftBadge } from "./DraftBadge";
import { LanguageProvider } from "../contexts/LanguageContext";

describe("DraftBadge", () => {
  it("renders the draft label", () => {
    const { getByText } = render(
      <LanguageProvider>
        <DraftBadge />
      </LanguageProvider>,
    );
    expect(getByText(/draft/i)).toBeTruthy();
  });
});
```

If `LanguageProvider` needs props or async setup, mirror how an existing context-integration test (e.g. `contexts/AudioPlayerContext.test.tsx`) wraps providers. If wrapping the provider proves heavy, instead mock `useLanguage` to return `{ t: (k: string) => k }` and assert on the key text `common.draft` — keep one working assertion that the label renders.

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh -c 'cd <APP-worktree> && npm test -- DraftBadge'`
Expected: FAIL — `./DraftBadge` does not exist.

- [ ] **Step 3: Add the localized strings**

In `locales/en.json`, add to the `common` object: `"draft": "Draft"`.
In `locales/pt.json`, add to the `common` object: `"draft": "Rascunho"`.
Match the surrounding indentation and trailing-comma style of each file exactly.

- [ ] **Step 4: Implement `DraftBadge`**

Create `components/DraftBadge.tsx`, mirroring `OfflineBadge.tsx`'s structure but with the saffron palette:

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLanguage } from "../contexts/LanguageContext";
import { colors } from "../constants/colors";

export function DraftBadge() {
  const { t } = useLanguage();
  return (
    <View style={styles.badge}>
      <Ionicons name="ellipse" size={8} color={colors.saffron[600]} />
      <Text style={styles.badgeText}>{t("common.draft") || "Draft"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.saffron[50],
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    gap: 4,
    flexShrink: 0,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.saffron[600],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
```

Match the import style (`useLanguage` location, `colors` location) to what `OfflineBadge.tsx` actually uses; adjust paths if they differ.

- [ ] **Step 5: Run the test to verify it passes**

Run: `sh -c 'cd <APP-worktree> && npm test -- DraftBadge'`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `sh -c 'cd <APP-worktree> && npm run lint'`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git -C <APP-worktree> add components/DraftBadge.tsx components/DraftBadge.test.tsx locales/en.json locales/pt.json
git -C <APP-worktree> commit -m "feat(ui): add DraftBadge component and common.draft strings

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Render `<DraftBadge />` on event cards and the detail header

**Files:**
- Modify: `padmakara-app/app/(tabs)/(groups)/index.tsx` (`FeaturedEventCard`, `RecentEventCard`)
- Modify: `padmakara-app/app/(tabs)/_events/index.tsx` (`EventCard`)
- Modify: `padmakara-app/app/(tabs)/(groups)/[groupId].tsx` (the group events card)
- Modify: `padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx` (`eventTitleSection`)

Read each file's card/header JSX before editing. In every case the event object is a `Gathering` whose `status` is already `'draft'` for draft events (`mapEventStatus` handles this). There is no `role` check — the backend only delivers draft events to admins.

- [ ] **Step 1: Add the badge to each render site**

In each file, `import { DraftBadge } from "<correct relative path>/components/DraftBadge";` and render it conditionally next to the event title:

```tsx
{event.status === "draft" && <DraftBadge />}
```

Use the local variable name each component already uses for the event/gathering (`event`, `retreat`, `gathering`, etc.). Place the badge:
- `FeaturedEventCard` — near `styles.featuredTitle`.
- `RecentEventCard` — near `styles.recentTitle`.
- `EventCard` (`_events/index.tsx`) — near `styles.eventCardTitle`.
- `[groupId].tsx` card — next to the retreat title, alongside the existing `OfflineBadge` if present (wrap title + badges in a row `View` if needed for layout).
- `retreat/[id].tsx` — inside `eventTitleSection`, just below or beside `eventTitleText`.

Keep layout minimal — a sibling element in the existing title row. Do not restructure the cards.

- [ ] **Step 2: Verify the app test suite still passes**

Run: `sh -c 'cd <APP-worktree> && npm test'`
Expected: PASS — 211 prior tests + the DraftBadge test, all green.

- [ ] **Step 3: Lint + typecheck**

Run: `sh -c 'cd <APP-worktree> && npm run lint'`
Expected: no new errors. If the app has a typecheck script (`npx tsc --noEmit`), run it and confirm no new errors.

- [ ] **Step 4: Commit**

```bash
git -C <APP-worktree> add "app/(tabs)/(groups)/index.tsx" "app/(tabs)/_events/index.tsx" "app/(tabs)/(groups)/[groupId].tsx" "app/(tabs)/(groups)/retreat/[id].tsx"
git -C <APP-worktree> commit -m "feat(ui): show DraftBadge on event cards and the event detail header

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **API:** `sh -c 'cd <API-worktree> && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'` — all pass; `... bun run typecheck` — clean.
- [ ] **App:** `sh -c 'cd <APP-worktree> && npm test'` — all pass; `npm run lint` — clean.
- [ ] Re-read the spec's "Testing" section and confirm every listed scenario maps to a test that exists and passes.

---

## Notes for the implementer

- **Test-file existence:** Several backend test files may not exist yet. "Create or extend" means: if the file exists, add the new `describe` block and reuse its imports/helpers; if not, create it following the mock pattern documented in `padmakara-api/CLAUDE.md` (`vi.mock("../../src/db/index.ts", ...)` with chainable mocks) and used by existing files such as `tests/routes/health.test.ts`.
- **Drizzle returns all columns:** `db.query.events.find*` returns every column unless a `columns:` selector restricts it, so event rows already carry `status`. Only TypeScript parameter/interface types need widening — no SQL `select` changes for that reason.
- **Frontend test scope:** The app does not unit-test screen-level components (see `padmakara-app/CLAUDE.md`). Task 9 is therefore verified by the existing suite staying green plus review of the JSX; only `DraftBadge` itself gets a dedicated unit test (Task 8).
- **Do not** touch the `admin/` React-admin UI or run `db:push`/migrations — this change has no schema impact.
