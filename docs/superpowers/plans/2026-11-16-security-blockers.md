# Security blockers before external testing

Date: 2026-11-16
Source: general security review of padmakara-api, its admin UI, padmakara-app and the deploy scripts.

## Goal

Close the four findings that block external testing, each on its own branch, each with a
test that reproduces the flaw before the fix. A second batch (listed at the end) is due
before the public release and is not planned in detail here.

## How to run it

- One branch per task, named as given. Tasks 1, 2 and 4 are independent and can run in
  parallel in separate worktrees. Task 3 touches `src/routes/auth.ts` like task 2: start
  it after task 2 is merged.
- Every task is reproduce-first: write the failing test, watch it fail for the stated
  reason, then fix. Run the suite with `bunx --bun vitest run` (plain `bun run test`
  fails on "Bun is not defined").
- Finish each task with `bun run typecheck` and the full suite.
- **Compatibility constraint:** iOS build 46 and the current Android build are in
  testers' hands. No API change in this plan may break them. Each task states what
  that means for it.
- Model column: Opus where the task carries a design decision or where a mistake in
  auth or money is expensive; Sonnet where the change is fully specified below.

| # | Task | Branch | Model | Size |
|---|------|--------|-------|------|
| 1 | Media token accepted as a session token | `fix/media-token-type-confusion` | Sonnet | small |
| 2 | Magic link activates a device on GET | `fix/magic-link-confirm-step` | Opus | medium |
| 3 | Device fingerprint is a weak permanent credential | `fix/device-fingerprint-credential` (API) and `fix/device-fingerprint-storage` (app) | Opus | large |
| 4a | Easypay webhook input hardening | `fix/easypay-webhook-input` | Sonnet | small |
| 4b | Easypay webhook trusts the request body | `fix/easypay-webhook-trust` | Opus | large |

Status 2026-11-16: tasks 1, 4a, 4b and 2 are merged into main. Task 3 starts from that
main, so its migrations are numbered after 0070 (task 4b's).

## Decisions needed from Jérémy

Each has a recommended default; the task proceeds with the default unless told otherwise.

1. **Magic link (task 2):** User decision (2026-11-16): keep the link and make it open
   a confirmation page; the 6-digit code stays. Admin and superadmin accounts are the
   exception: the link never activates a device for them, only the code does, because
   an admin token opens the whole backoffice API.
2. **Fingerprint (task 3):** User decision (2026-11-16): keep "an activated device
   signs back in without email", on every platform including web, limited to devices
   used within the last 12 months (`device_activations.last_used`). Older activations
   go back through email. A web-only restriction was considered and dropped: the
   60-day refresh token already sits in the same browser storage, and the server cannot
   verify a client-declared device type.
3. **Fingerprint migration (task 3):** User decision (2026-11-16): keep existing
   devices signed in and migrate them when they install the new app build. Fall back to
   revoking all activations on deploy (every tester signs in again) only if the
   migration proves too complex; say so before switching.

---

## Task 1 — Media token accepted as a session token

**Model: Sonnet.** Fully specified, two files, no design choice.

**Flaw.** `issueMat` (`src/services/media-access.ts`) signs with the JWT secret and
`verifyAccessToken` (`src/services/auth.ts:66`) only rejects `type === "refresh"`. A
`?mat=` token sent as `Authorization: Bearer` authenticates as its `sub` for 4 hours.
An anonymous viewer of a public video gets a token for user id 0.

**Change.**
- `createAccessToken` adds the claim `type: "access"`.
- `verifyAccessToken` accepts a token only when `type === "access"`, or, for tokens
  issued before this deploy, when `type` is absent **and** `email` and `role` are
  strings **and** there is no `svid` claim. Add a comment that the second arm can be
  deleted one hour after deploy (access tokens live 1 h).
- `issueMat` adds `type: "media"`. `verifyMat` requires `svid`, `gid` as today and
  rejects any token whose `type` is present and not `"media"` (tokens in flight for up
  to 4 h have no type).
- `authMiddleware` and `optionalAuthMiddleware` (`src/middleware/auth.ts`): stop using
  `payload.email!` / `payload.role!`; reject when `sub`, `email` or `role` is missing.

**Tests first** (`tests/services/auth.test.ts` or the existing auth middleware tests,
and `tests/routes/media.test.ts`):
- a MAT for user 42 sent as Bearer to an authenticated route returns 401;
- a MAT for user 0 is not treated as a signed-in user by `optionalAuthMiddleware`;
- an access token is rejected by `verifyMat`;
- a legacy access token (no `type`, with email and role) is still accepted;
- a refresh token is still rejected.

**Compatibility.** None broken: old access tokens pass through the legacy arm, old MATs
keep playing.

---

## Task 2 — Magic link activates a device on GET

**Model: Opus.** Changes the sign-in flow; must not break the app's polling or the
code path, and the page is the one thing every user sees.

**Flaw.** `GET /api/auth/activate/:token` (`src/routes/auth.ts:422`) consumes the token
and activates the fingerprint stored with it. A mail-gateway link scanner, a prefetch or
a habitual click activates an attacker's device; `/device/discover` then hands the
attacker tokens, including an admin's.

**Change (default decision 1).**
- `GET /activate/:token` no longer consumes anything. For a valid token it renders a
  confirmation page: the device name and type stored on the token, the email, and one
  button. Text in en/pt as today, plus a line telling the reader to close the page if
  they did not ask to sign in. Escape `deviceName` (it is client-supplied) — add an
  `escapeHtml` to `renderActivationPage` and use it for every interpolated value.
- `POST /activate/:token` does what the GET does today (consume, find or create the
  account, activate the device, render the success page). Consume atomically:
  `UPDATE … SET is_used = true WHERE id = ? AND is_used = false RETURNING`, as
  `claimSignInCode` does, so two clicks cannot both activate.
- Admin exception: when the token's email belongs to an `admin` or `superadmin`
  account, neither verb activates anything. The page says, in en/pt, to type the code
  from the email into the app instead. The token is left unused so its code still
  works. Regular accounts and addresses with no account yet follow the normal path.
- The page sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Email copy (`buildMagicLinkEmail`): no change needed, the link still works.

**Tests first** (`tests/routes/auth.test.ts`):
- GET with a valid token leaves `is_used` false and creates no `device_activations` row
  (this is the reproduction: it fails today);
- POST with the same token activates the device and marks the token used;
- a second POST gets the invalid-link page;
- a device name containing `<script>` is rendered escaped;
- expired and unknown tokens render the invalid-link page on both verbs.

**Compatibility.** The app only polls `/device/discover`; it does not call
`/activate`. Build 46 keeps working. Check `padmakara-app/.maestro` and the Playwright
e2e helpers for flows that open the link and expect activation on GET, and update them.

---

## Task 3 — Device fingerprint is a weak permanent credential

**Model: Opus.** Two repositories, a schema migration with a data step, a rollout
order, and a compatibility window with builds already installed.

**Flaw.** The fingerprint alone obtains tokens (`/device/discover`, and the
`already_activated` branch of `/request-magic-link`). It is generated with
`Math.random()` plus device model and a timestamp
(`padmakara-app/services/magicLinkService.ts:142`), kept in AsyncStorage / localStorage,
included in Android backups, not removed on sign-out, returned by `GET /auth/devices`,
and stored in clear in `device_activations` and `magic_link_tokens`.

### 3a — API (`fix/device-fingerprint-credential`)

1. **Stop handing it out.** `GET /auth/devices` drops `device_fingerprint` from the
   response (the app does not read it). `/device/discover` drops it from the `device`
   block.
2. **Hash at rest.** Store `sha256(fingerprint)` hex instead of the fingerprint in
   `device_activations.device_fingerprint` and `magic_link_tokens.device_fingerprint`.
   Every lookup hashes its input first (`auth.ts`, `passkeys.ts`,
   `services/device-activation.ts`, `services/sign-in-code-claim.ts`). The backoffice
   challenge prefix `backoffice:` is hashed with the rest. Migration: custom
   (`bun run db:generate --custom --name hash_device_fingerprints`) with
   `UPDATE … SET device_fingerprint = encode(sha256(convert_to(device_fingerprint, 'UTF8')), 'hex')`
   on both tables; widen the column if it is shorter than 64. The migration is not
   re-runnable as written: guard it (for example only rows whose value is not already
   64 hex characters) and say so in a comment.
3. **Make discover a one-time claim.** Add `pending_claim boolean` to
   `device_activations` (generated migration). `POST /activate/:token` sets it;
   `/device/discover` returns tokens only when it is true and clears it in the same
   `UPDATE … RETURNING`. Otherwise it answers `not_activated`.
4. **Sign-back-in (default decision 2).** The `already_activated` branch of
   `/request-magic-link` stays, but only for a fingerprint of at least 43 characters of
   base64url (the new format) whose activation has `last_used` within the last 12
   months. Shorter, legacy fingerprints and older activations fall through to the email
   path. Tighten `device_fingerprint` in `src/lib/schemas.ts` from `min(1)` to
   `min(16).max(128)` after checking the length the current builds send.
5. **Rotation endpoint.** `POST /auth/device/rotate` (authenticated):
   `{ old_fingerprint, new_fingerprint }`, moves the caller's activation to the new
   hash. 404 when the old one is not the caller's.
6. **Sign-out.** `/device/deactivate` already exists; no change.

Tests first: discover returns tokens once and `not_activated` the second time; a
legacy-format fingerprint no longer gets tokens from `/request-magic-link`; `/devices`
carries no fingerprint; rotate refuses another user's fingerprint; rows are stored
hashed.

### 3b — App (`fix/device-fingerprint-storage`, in padmakara-app)

1. Generate 32 random bytes with `expo-crypto` (`getRandomBytesAsync`), base64url.
   Remove the device-info JSON and both `Math.random()` fallbacks; if secure storage is
   unavailable, fail the sign-in with a localized error rather than inventing a weaker
   value.
2. Store it through `services/tokenStorage.ts` (SecureStore on native, the existing
   web path on web), not AsyncStorage.
3. Migration on first launch of the new build: if a legacy `device_fingerprint` exists
   in AsyncStorage and the user is signed in, generate the new one, call
   `/auth/device/rotate`, then delete the legacy key. If signed out, just delete it.
4. Sign-out (`clearLocalSession`, `forgetDevice`): delete the fingerprint as well, so
   the next sign-in creates a fresh one.
5. Remove the `console.log` at `magicLinkService.ts:593` that prints the discover
   response.
6. Any new user-facing string goes through `t()` with keys in `locales/en.json` and
   `locales/pt.json`; never the word "subscription".
7. Follow-ups from task 2 (merged 2026-11-16), which changed `GET /auth/activate/:token`
   into a confirmation page whose button POSTs to the same URL:
   - `.maestro/run-signed-in.sh` opens the link with `curl -s -o /dev/null "$url"`, which
     now only fetches the page: use `curl -s -X POST -o /dev/null "$url"`.
   - `getDeviceInfo` in `services/magicLinkService.ts` falls back to `"Android Device"`
     on web when the device and model names are empty, so the confirmation page would
     read "Android Device (web browser)". Send a name that matches the platform.

### Rollout order

API 3a.1 (stop handing it out) can ship at once. 3a.2–3a.5 ship together, and before
the app build that carries 3b. With default decision 3, devices on build 46 stay signed
in through their refresh token and migrate when they install the next build; a build-46
device whose refresh token expires signs in again by email or code, which still works.

**Compatibility.** Verify against build 46 before deploying: sign-in by link, by code
and by passkey, cold start with a valid session, sign-out then sign-in.

---

## Task 4 — Easypay webhook

### 4a — Input hardening (`fix/easypay-webhook-input`)

**Model: Sonnet.** Fully specified and independent of 4b.

- At the top of `POST /api/payment/webhook` (`src/routes/payment.ts:893`), reject any
  `id` that is not a UUID with `200 { received: true, ignored: "bad id" }` **before**
  the dedupe insert. Confirm the format first against the ids in existing
  `tests/routes/payment-webhook*.test.ts` fixtures and the stored
  `payment_transactions.notification_id` values; if real ids are not UUIDs, use the
  strictest pattern that matches them and say which.
- Wrap `id` in `encodeURIComponent` at the three call sites that interpolate it raw
  (`payment.ts:1017`, `:457`, `:489`).
- Cap the body: read at most 64 KB, answer 413 beyond.
- Add `authIpLimiter({ limit: 120, windowMs: 60_000 })` to the route.

Tests first: an id of `../single/abc` makes no Easypay call and inserts no row; a
100 KB body is refused; a normal notification still passes.

### 4b — Stop trusting the request body (`fix/easypay-webhook-trust`)

**Model: Opus.** Needs the Easypay API contract worked out against the real responses,
and it is the code that decides who has paid.

**Flaw.** After re-reading the subscription from Easypay, the handler decides that money
arrived from the body's `type` and `status` (`classifyNotification`, `payment.ts:1111`).
A user who owns a subscription id can post `subscription_capture/success` and gain or
extend access; varying `date` defeats the dedupe key. `type: "refund"` with a member's
id closes their access. Separately, a real capture is lost when the verification call
fails: the handler answers 200, marks the row `unverified`, and nothing reconciles.

**Change.**
1. **Find the source of truth.** Establish from the Easypay API 2.0 documentation and
   from stored `raw_subscription` / `raw_payload` rows how a capture is read back: the
   transactions (captures) of a subscription, each with its own id, status, amount and
   date. Read the memory note "Easypay API 2.0 field mapping" first: the fields
   `payment.ts` once assumed did not exist in real responses. Do not guess the shape;
   if it cannot be confirmed from documentation or stored payloads, stop and ask.
2. **Credit captures, not notifications.** On any subscription notification, fetch the
   subscription's captures from Easypay and credit each one that is paid and not yet
   recorded, keyed on Easypay's transaction id (new unique column on
   `payment_transactions`, generated migration). The body's `type`/`status` become a
   hint for logging only. Extending access becomes a function of "paid captures we have
   not counted", so replaying or forging a notification changes nothing.
3. **Reversals.** Close access only when Easypay reports the refund or chargeback on a
   capture we had credited.
4. **Do not lose a payment.** When the Easypay read fails for a reason other than a
   definite "this id is not a subscription" (404), delete the dedupe claim and answer
   503 so Easypay retries, as the teaching branch already does. Same when a DB write
   throws after the claim.
5. **Reconcile.** A periodic job (same pattern as `startUsagePruning`) that runs the
   same "credit uncounted paid captures" function over active Easypay subscriptions,
   so a notification that never arrives is still counted. Log what it credits.
6. **Atomic expiry.** Compute the new `subscription_expires_at` inside one SQL update
   or under a row lock, so two captures for one user cannot overwrite each other.

**Tests first** (`tests/routes/payment-webhook.test.ts`):
- a `subscription_capture/success` body for a subscription with no paid capture at
  Easypay changes nothing on the user (the reproduction: fails today);
- the same notification posted twice with different `date` values extends once;
- a `refund` body with no refund at Easypay leaves access open;
- an Easypay 500 on the read answers 503 and leaves no dedupe row;
- a real paid capture extends access by one interval and is not counted again by the
  reconcile job.

**Compatibility.** Server-only. Before deploying to production, replay the stored
notifications of the live account in a dry run and compare the resulting expiry dates
with the current ones; report any member whose date would move.

---

## Reminder for Jérémy when all tasks are done

Asked on 2026-11-16: remind him, at the very end, to check this in the Easypay
backoffice.

- `payment_transactions` row 54 in production: a `subscription_capture` / `success`
  notification received on 2026-11-07 at 20:41 (server time) that could not be verified
  (Easypay answered 404 on the subscription) and is attached to no member. Look for a
  capture around that time in the Easypay backoffice. If it is a real payment, find
  which member it belongs to: that member did not get their extension and must be
  credited by hand.
- Row 4 (2026-10-07 13:20, `capture`, same 404) predates the production switch of
  2026-10-28 and is almost certainly a test; confirm it in passing.

---

## Second batch — before the public release

Not planned in detail. Model recommendation per item.

| Item | Model | Why |
|------|-------|-----|
| Admin user delete does not stop the Easypay subscription (`src/routes/admin/users.ts:153`): call `deleteUserAccount` or its `stopRecurringPayment` | Sonnet | reuse of an existing service |
| Admin vs superadmin separation on `role`, `isActive`, delete; no self-promotion | Opus | needs a rule for who may do what, then small code |
| Backoffice stored XSS: render titles as React children in the delete dialogs (`events.tsx:4975,5028`, `groups.tsx:245`) | Sonnet | mechanical |
| SSRF on `photoUrl` re-crop (`src/lib/image-source.ts`) and video import URL: resolve and check the IP, manual redirects, size cap | Opus | easy to get subtly wrong |
| Bookmark and progress routes check the audience, not only the status (`src/routes/content.ts`) | Sonnet | apply the existing `checkEventAccess` |
| `/api/events/featured` applies the audience check or strips content | Sonnet | same pattern as `/public/:id` |
| Test routes mounted only when `NODE_ENV === "test"` or an explicit flag; production refuses an empty Easypay account id and defaults `EASYPAY_TESTING` to false | Sonnet | config guards plus tests |
| Request body limit (`bodyLimit`), rate limit on `/api/search`, bind Bun to 127.0.0.1, drop Postgres `detail` from error responses | Sonnet | small, specified |
| CSP and HSTS for app and admin vhosts in `deploy/padmakara-api.caddy` | Opus | a wrong CSP breaks the web app and Easypay checkout; needs testing in a browser |
| Server: replace `NOPASSWD: /usr/bin/cp`, `chmod 600` the `.env`, backups with `umask 077` and a put-only IAM user | Opus | production host changes, done with Jérémy |
| Dependency updates (`sharp`, AWS SDK, hono), then the rest of `bun audit` | Sonnet | run, test, report |
| Remove tracked data files (`uploads/migrations/*.csv`, migration reports, `data/s3-inventory.json`) and check sharing on the old bucket and Drive links | Opus for the check, Sonnet for the removal | the check decides whether content is exposed |
| Remove the dead `?auto_activate=` deep link and `/auth/auto-activate` | Sonnet | deletion, after confirming nothing emits such links |
