# Admin Draft Event Visibility — Design

**Date:** 2026-05-19
**Status:** Approved
**Repos:** `padmakara-api` (backend), `padmakara-app` (frontend)

## Goal

Admins and superadmins see `draft` events while using the mobile/web app. Normal
users and guests continue to see only `published` events. `archived` events stay
hidden from everyone in the app.

## Background

- `events.status` ∈ {`draft`, `published`, `archived`}, default `draft`
  (`src/db/schema/retreats.ts`).
- `users.role` ∈ {`user`, `admin`, `superadmin`} (`src/db/schema/users.ts`).
- Today the authenticated app endpoints hard-filter `status = "published"` for
  everyone — admins included — and the central access function
  `checkEventAccess()` ignores `status` entirely. As a result:
  - Admins cannot see drafts anywhere in the app.
  - Normal users *can* reach a draft event's content (sessions, tracks, media
    URLs, transcripts) by ID, because per-resource endpoints never check
    `status`.
- Public/unauthenticated endpoints (`/events/public`, `/events/featured`,
  `/events/public/:id`) correctly serve only `published`, but cannot currently
  identify an admin caller. The app already attaches the JWT to every request,
  so these endpoints only need to *optionally* read it.

## Non-Goals

- `archived` events stay hidden for everyone in the app, admins included.
- A user's own historical private data (`GET /content/progress`,
  `/content/last-played`) is not retroactively filtered. Stale rows referencing a
  now-draft event are harmless and remain.
- The React-admin UI (`admin/`) is unchanged — it already shows all statuses.
- No `role` field is added to the frontend; the app infers admin context purely
  from receiving a draft event.

## Architecture

### Principle: status is a first-class access rule

The central function `checkEventAccess(user, event)` in `src/services/access.ts`
becomes status-aware. Because event-content endpoints already funnel through it
(directly, or via `requireEventAccess` / `authorizeVideoSessionAccess`), one
change there enforces the rule across the event-detail, sessions, tracks, all
`/api/media/*`, and video-progress endpoints at once.

The endpoints that do *not* route through `checkEventAccess` are handled
explicitly: the list endpoints (which pre-filter status in SQL) and the
`content.ts` write endpoints.

### Visibility rule

`eventStatusVisibleTo(role)`:
- `admin` / `superadmin` → `["published", "draft"]`
- everything else, including unauthenticated (`null`/`undefined` role) →
  `["published"]`

`archived` is in neither set → never visible in the app.

## Backend changes (`padmakara-api`)

### 1. `src/services/access.ts` — status-aware access

- Add `status: string` to the `EventForAccess` interface.
- Add exported helper `eventStatusVisibleTo(role: string | null | undefined):
  string[]`.
- In `checkEventAccess`, before the audience logic: if `event.status` is not in
  `eventStatusVisibleTo(user?.role)`, return
  `{ allowed: false, reason: "STATUS_HIDDEN" }`.
- Add `"STATUS_HIDDEN"` to the `AccessResult.reason` union.
- `filterAccessibleEvents` needs no change — it already drops `!allowed` events,
  so draft events drop out for a non-admin automatically.

### 2. `src/routes/events.ts`

- `requireEventAccess`: remove the admin early-return; always call
  `checkEventAccess`. Map the result — `allowed` → return; `STATUS_HIDDEN` →
  `AppError.notFound("Event not found")`; `AUTH_REQUIRED` →
  `AppError.unauthorized(...)`; otherwise → `AppError.forbidden(...)`. Widen the
  `event` parameter type to include `status`.
- `GET /api/events` (authenticated list): the admin branch SQL filter changes
  from `eq(events.status, "published")` to
  `inArray(events.status, ["published", "draft"])`. The regular-user branch
  keeps `eq(..., "published")` (drafts would be dropped by `checkEventAccess`
  anyway; keeping the SQL filter avoids fetching them).
- `GET /api/events/public`, `GET /api/events/public/:id`,
  `GET /api/events/featured`: apply optional authentication (`getOptionalUser`).
  Replace the hard-coded `eq(events.status, "published")` with
  `inArray(events.status, eventStatusVisibleTo(user?.role))`. For
  non-admins/guests this is byte-for-byte the current behavior.
- `GET /api/events/:id`: no direct change — it already calls
  `requireEventAccess`, which now enforces status.
- `POST /api/events/:id/request-download` and
  `POST /api/events/public/:id/request-download`: call `checkEventAccess`
  directly — once it is status-aware, a non-admin requesting a draft download is
  denied automatically.

### 3. `src/routes/groups.ts`

- `GET /api/groups/:id/events`: the event-fetch SQL filter becomes role-aware —
  `inArray(events.status, eventStatusVisibleTo(user.role))`. `filterAccessibleEvents`
  then applies audience rules as before.
- `GET /api/groups`: unchanged. The admin branch already returns all groups; the
  regular branch derives groups from published accessible events.

### 4. `src/routes/content.ts` — write endpoints (defense in depth)

These three endpoints do not route through `checkEventAccess`. Add an explicit
status guard so a non-admin cannot create state against a draft event:
- `POST /api/content/progress` — resolve the track's event; if its status is not
  visible to the caller → `AppError.notFound`.
- `POST /api/content/event-bookmarks` — check the bookmarked event's status.
- `POST /api/content/track-bookmarks` — resolve the track's event; check status.

Read endpoints for the user's own data are intentionally left unchanged (see
Non-Goals). The video-progress endpoints already route through
`authorizeVideoSessionAccess` → `checkEventAccess` and are covered by change 1.

### Reason → HTTP status mapping

`STATUS_HIDDEN` surfaces as **404 Not Found** on the event-detail / sessions /
tracks paths (via `requireEventAccess`). The `/api/media/*` handlers currently
map any non-`AUTH_REQUIRED` denial to **403**; they will additionally map
`STATUS_HIDDEN` to **404** for consistency. Net behavior: a draft event is
indistinguishable from a non-existent one for a non-admin.

### Verifying event-loading helpers carry `status`

`checkEventAccess` now reads `event.status`. Drizzle `db.query.events.find*`
returns all columns unless `columns:` restricts them, so runtime objects already
include `status`. Implementation must confirm the media helpers
(`getEventForTrack`, `getEventForSession`, `getEventForTranscript`) and
`authorizeVideoSessionAccess`'s `session.event` query do not restrict columns,
and that any narrowed event object literal passed to `checkEventAccess` includes
`status`.

## Frontend changes (`padmakara-app`)

The app already attaches the JWT to every request (`services/apiService.ts`), and
`mapEventStatus()` already maps backend `draft` → frontend
`Gathering.status = 'draft'` (`services/retreatService.ts`). Once the backend
serves drafts to admins, draft events flow into every screen with no data-layer
change.

### 1. `<DraftBadge />` — `components/DraftBadge.tsx`

A small pill mirroring `components/OfflineBadge.tsx`'s structure, visually
distinct via the saffron palette (`colors.saffron` from `constants/colors.ts`).
Label from a localized key.

### 2. Localization

New key `common.draft` → `"Draft"` (en) / `"Rascunho"` (pt) in `locales/en.json`
and `locales/pt.json`.

### 3. Render the badge where `gathering.status === 'draft'`

- Home featured card — `app/(tabs)/(groups)/index.tsx` `FeaturedEventCard`.
- Home recent card — `app/(tabs)/(groups)/index.tsx` `RecentEventCard`.
- Public events card — `app/(tabs)/_events/index.tsx` `EventCard`.
- Group events card — `app/(tabs)/(groups)/[groupId].tsx` (and
  `retreats/[code].tsx` `RetreatCard` if rendered there).
- Event detail header — `app/(tabs)/(groups)/retreat/[id].tsx`
  `eventTitleSection`.

No `role` check on the frontend: the backend only sends a draft event to an
admin, so `status === 'draft'` ⇒ the viewer is an admin.

## Data flow

- Guest → public endpoint, no token → `eventStatusVisibleTo(undefined)` =
  `["published"]` → published only. (unchanged)
- Normal user → any endpoint, role `user` → `["published"]` → published only; a
  probed draft ID → 404.
- Admin → any endpoint, role `admin`/`superadmin` → `["published","draft"]` →
  drafts included; the app renders `<DraftBadge />` on them.

## Error handling

- Hidden-status event for a non-admin → 404 (indistinguishable from a genuine
  not-found).
- `archived` event by ID, any user → 404.
- Unauthenticated request to an authenticated endpoint → 401 (unchanged).

## Testing

### Backend (Vitest, mocked db)
- `checkEventAccess`: admin sees `draft` + `published`; user sees only
  `published`; `archived` denied for admin and user; guest (`null` user) sees
  only `published`.
- `requireEventAccess`: 404 for a draft event + non-admin; passes for admin;
  passes for published + accessible user.
- `GET /api/events`: admin response includes draft events; user response
  excludes them.
- `GET /api/groups/:id/events`: same role split.
- `GET /api/events/public` and `/featured`: with an admin token → drafts
  included; without a token / with a user token → published only.
- `content.ts` write endpoints: non-admin POST against a draft event → 404;
  admin → succeeds.

### Frontend (Jest + React Testing Library)
- `<DraftBadge />` renders its label.
- An event card renders `<DraftBadge />` when `status === 'draft'` and not
  otherwise.

## Rollout

Pure code change, no database migration, no env-var or config change. Backend
deploys independently of the app; until the app build ships, an admin sees
drafts un-badged — acceptable.
