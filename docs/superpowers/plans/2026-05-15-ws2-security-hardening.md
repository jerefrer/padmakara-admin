# WS2 — Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Address the HIGH and MEDIUM findings from the pre-launch security audit — rate limiting, security headers, secret startup guards, an IDOR fix, query-param-token removal, admin input validation, presigned-URL cache scoping, removal of a legacy endpoint, and secure token storage in the app.

**Architecture:** Mostly additive backend changes in `padmakara-api` (middleware, config guards, validation) plus one frontend change in `padmakara-app` (token storage). Verified by the unit suite + the WS1 e2e suite (`bun run test:e2e` — the access-control matrix must stay green). Two changes intentionally alter behaviour (magic-link response unification, rate-limit 429s) — expect ~2-3 existing assertions to be deliberately updated.

**Tech Stack:** Hono, Bun, Drizzle, Vitest, `hono-rate-limiter`, `hono/secure-headers`, `expo-secure-store`.

**Spec:** `docs/superpowers/specs/2026-05-15-pre-launch-hardening-design.md` (§5). Source audit findings referenced as H1–H4, M1–M6.

**Branch:** `feature/security-hardening` (off `main`, `padmakara-api`). The frontend task (M2) uses a `feature/security-hardening` branch in `padmakara-app`.

## Conventions

- Repo root (backend): `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api`. App: `.../padmakara-app`.
- zoxide → `sh -c 'cd <abs> && <cmd>'`.
- Unit tests: `... bun node_modules/.bin/vitest run <file>`. E2e: `... bun run test:e2e`. Typecheck: `... bun run typecheck`.
- Conventional Commits; messages end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Never `git add` `src/scripts/fix-misattributed-pt-tracks.ts`.
- **Audit line numbers may have drifted** — implementers must read the actual code to locate the exact spot; the audit's intent is authoritative, not the line number.

## Setup

- [ ] **Step 0:** `git -C <api-root> checkout main && git -C <api-root> checkout -b feature/security-hardening`

---

## Task 1: H3 + M1 — Secret startup guards + refresh-token lifetime

**Audit:** H3 — `JWT_SECRET` falls back to a publicly-known dev default (`config.ts`); `READ_ALONG_WEBHOOK_SECRET` and the Bunny webhook secret similarly. M1 — refresh token expiry is `365d`.

**Files:** `src/config.ts`; test `tests/config.test.ts` (create).

- [ ] Read `src/config.ts`. Add a startup-validation block that runs at module load: when `nodeEnv === "production"`, throw a clear fatal error if any of these hold: `JWT_SECRET` equals `"dev-secret-change-in-production"` or is shorter than 32 chars; `READ_ALONG_WEBHOOK_SECRET` equals `"dev-webhook-secret"`; the Bunny webhook secret is empty/default. Also: if `NODE_ENV` is unset entirely (so it defaulted to `"development"`) that is fine for dev — but the production guard only triggers when explicitly `production`, which is correct.
- [ ] Change `refreshTokenExpiry` default from `"365d"` to `"60d"`.
- [ ] Test (`tests/config.test.ts`): a `validateProductionConfig`-style exported function (extract the guard into a testable pure function that takes a config-like object) — assert it throws for a dev-default `JWT_SECRET` under production and passes for a strong secret. Keep the module-load call thin (`if (production) validateProductionConfig(...)`).
- [ ] `bun run test` for the new test + `bun run typecheck`. Commit: `feat(api): fail fast on weak secrets in production; shorten refresh token to 60d`.

---

## Task 2: H4 — Security headers

**Audit:** `src/index.ts` has only `logger()` + `cors()`; no `secureHeaders()` — clickjacking/MIME-sniffing exposure on admin and auth pages.

**Files:** `src/index.ts`; test `tests/routes/security-headers.test.ts` (create).

- [ ] Read `src/index.ts`. Add `import { secureHeaders } from "hono/secure-headers"` and `app.use("*", secureHeaders())` early in the middleware chain. If a CSP would break the Easypay checkout page (`src/routes/payment.ts` serves an HTML page embedding the Easypay SDK) or the magic-link activation HTML page, scope/relax CSP for those specific routes rather than disabling headers globally — read those routes and configure `secureHeaders` so the SDK/script still loads there. Prefer the default `secureHeaders()` (which does not set a restrictive CSP by default) unless a CSP is explicitly wanted; at minimum get `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options: nosniff`, and HSTS.
- [ ] Test: a request to `/health` (or any route) has `X-Content-Type-Options: nosniff` and the frame-protection header present.
- [ ] `bun run test` + `bun run test:e2e` (confirm nothing broke) + `bun run typecheck`. Commit: `feat(api): add secure-headers middleware`.

---

## Task 3: M6 — Remove the legacy `/verify-magic-link` endpoint

**Audit:** confirmed unused by the app; auto-creates accounts. Remove it.

**Files:** `src/routes/auth.ts`, `src/lib/schemas.ts`; tests in `tests/routes/auth.test.ts`.

- [ ] Read `src/routes/auth.ts` around the `/verify-magic-link` handler and `src/lib/schemas.ts` for `verifyMagicLinkSchema`. Implementation-time check: confirm no server-side magic-link email template generates a `/verify-magic-link` URL (grep the codebase for `verify-magic-link`). If a template does, STOP and report — do not break live email links.
- [ ] Remove the `/verify-magic-link` route handler, the `verifyMagicLinkSchema`, and its now-unused import. Remove any test in `tests/routes/auth.test.ts` that targets that endpoint.
- [ ] `bun run test` + `bun run typecheck`. Commit: `refactor(api): remove unused legacy /verify-magic-link endpoint`.

---

## Task 4: M5 — Scope the presigned-URL cache to image keys

**Audit:** `generatePresignedDownloadUrl` (`src/services/s3.ts`) caches by S3 key alone; audio/transcript URLs (sensitive content) get a longer effective lifetime than intended. Cache should cover only avatar/cover images.

**Files:** `src/services/s3.ts`; test in `tests/services/` (create or extend).

- [ ] Read `src/services/s3.ts` — the cache logic and the key-builder functions. Restrict caching so only image keys (teacher/group avatar + hero keys) are cached; audio (`events/.../*.mp3`), transcript, and ZIP keys bypass the cache (always freshly signed). Implement via a key-prefix/predicate check.
- [ ] Test: a presigned URL for a track key is not served from cache on repeat calls (or: an image key is cached, a track key is not — assert the predicate). Keep it a focused unit test of the cache predicate.
- [ ] `bun run test` + `bun run typecheck`. Commit: `fix(api): scope presigned-URL cache to image keys only`.

---

## Task 5: M4 — Validate admin upload route inputs

**Audit:** `src/routes/admin/upload.ts` `presign-transcript` and `infer-sessions` cast `c.req.json()` to a type with no runtime validation; `filename` flows unsanitised into an S3 key (path-traversal surface).

**Files:** `src/routes/admin/upload.ts`; tests in `tests/routes/admin/` (create `upload.test.ts` or extend).

- [ ] Read `src/routes/admin/upload.ts`. Add Zod schemas for the `presign-transcript` and `infer-sessions` request bodies. The `filename` field must reject `..`, `/`, `\`, and control characters (a `.regex(...)` or `.refine(...)`). Use `.safeParse` and return `AppError.badRequest` on failure, matching the codebase pattern.
- [ ] Tests: valid body → 200/expected; a `filename` containing `../` → 400; missing required field → 400. (These routes are admin-gated — the test must authenticate as admin; see how existing `tests/routes/admin/*.test.ts` do it.)
- [ ] `bun run test` + `bun run typecheck`. Commit: `fix(api): add Zod validation + path-traversal guard to admin upload routes`.

---

## Task 6: M3 — Drop query-parameter JWT acceptance

**Audit:** `optionalAuthMiddleware` (`src/middleware/auth.ts`) accepts a JWT via `?token=` — credentials leak into logs/referrers. The MAT (media-access-token) system already covers the legitimate HLS/iframe case.

**Files:** `src/middleware/auth.ts`; tests in `tests/` as appropriate.

- [ ] Read `src/middleware/auth.ts` `optionalAuthMiddleware`, and confirm via the routes it guards (`media.ts`, `downloads.ts`, `publications.ts`, `search.ts`) and the MAT system (`src/services/media-access.ts`) that nothing legitimate depends on `?token=` JWT. If the app or a route genuinely relies on `?token=`, STOP and report — do not silently break it.
- [ ] Remove the `?token=` fallback so `optionalAuthMiddleware` reads the JWT only from the `Authorization: Bearer` header.
- [ ] Run `bun run test` and `bun run test:e2e` — fix/adjust any test that relied on `?token=` (the access-control e2e or media tests). Commit: `fix(api): stop accepting JWTs from the ?token= query parameter`.

---

## Task 7: H2 — Anonymous ZIP download access re-check

**Audit:** `verifyDownloadAccess` (`src/routes/downloads.ts`) treats anonymous download requests as world-readable by request id; a stale anonymous request still serves a full-event ZIP even after the event's audience changes from public to restricted.

**Files:** `src/routes/downloads.ts`; `DECISIONS.md` (create/append at `padmakara-api/DECISIONS.md`); tests in `tests/routes/downloads.test.ts`.

- [ ] Read `src/routes/downloads.ts` (`verifyDownloadAccess`, the status + download handlers) and how anonymous download requests are created (`src/routes/events.ts` public request-download). At download time for an anonymous request, re-verify the associated event is STILL public (`free-anyone` audience / published) — if not, deny. Authenticated requests keep their existing owner check.
- [ ] Append a `DECISIONS.md` entry documenting the anonymous-public-ZIP model (UUID-addressed, public content, re-verified at download time) per the project's decision-log format.
- [ ] Tests: anonymous download of a still-public event → works; anonymous download after the event is made non-public → denied.
- [ ] `bun run test` + `bun run test:e2e` + `bun run typecheck`. Commit: `fix(api): re-verify event is public at anonymous ZIP download time`.

---

## Task 8: H1 — Rate limiting on auth endpoints

**Audit:** no rate limiting anywhere — magic-link email bombing, login brute-force, member-email enumeration. Largest task.

**Files:** `package.json` (add `hono-rate-limiter`), a new `src/middleware/rate-limit.ts`, `src/routes/auth.ts`, `src/index.ts` as needed; tests in `tests/routes/auth.test.ts` / a new `tests/middleware/rate-limit.test.ts`.

- [ ] Add the `hono-rate-limiter` dependency (`bun add hono-rate-limiter`).
- [ ] Create `src/middleware/rate-limit.ts` — configurable rate-limit middleware factories: a per-IP limiter and a per-email limiter (keyed on the request body's email). Sensible limits (e.g. ~5 requests / 15 min for magic-link/approval/login per IP and per email; a looser limit for `device/discover`). Make limits overridable so tests can use a tiny window.
- [ ] Apply the limiters to the auth POST endpoints in `src/routes/auth.ts`: `request-magic-link`, `request-approval`, `login`, and `device/discover`.
- [ ] **Magic-link response unification:** in the `request-magic-link` handler, make the success response identical whether or not the email belongs to a known user (do not return a distinguishing `approval_required` vs `magic_link_sent`). The genuine outcome is communicated only via the email actually sent. Keep `request-approval` behaviour but ensure it does not leak existence either. *This is an intentional behaviour change — update the corresponding assertions in `tests/routes/auth.test.ts` and any e2e/app-contract test that asserted the old shape.*
- [ ] Tests: rapid repeated requests to `request-magic-link` from the same IP eventually get `429`; the magic-link response shape is identical for a known vs unknown email.
- [ ] `bun run test` + `bun run test:e2e` + `bun run typecheck`. Commit: `feat(api): rate-limit auth endpoints and stop leaking account existence`.

---

## Task 9: M2 — Secure token storage in the app

**Audit:** `padmakara-app` stores `auth_token` / `refresh_token` in `AsyncStorage` (unencrypted on native; `localStorage` on web). Move to `expo-secure-store` on native, with transparent migration (no forced re-login).

**Files:** `padmakara-app` — `services/apiService.ts`, `services/authService.ts`, `services/retreatService.ts`, and wherever the token is read/written. `package.json` (`expo-secure-store`).

- [ ] In `padmakara-app`: `git checkout -b feature/security-hardening`. Add `expo-secure-store` (`npx expo install expo-secure-store`).
- [ ] Read how `auth_token` / `refresh_token` are read and written across the services. Introduce a small token-storage abstraction: on native (`Platform.OS !== "web"`) use `expo-secure-store`; on web keep `AsyncStorage`/`localStorage` (SecureStore is native-only). Route ALL token reads/writes through it.
- [ ] **Transparent migration:** on first access, if a token exists in the old `AsyncStorage` location but not in SecureStore, copy it to SecureStore and delete the old copy — existing logged-in users are not logged out.
- [ ] Verify: `npx tsc --noEmit` introduces no new errors; existing app tests still pass (`npm test`). Note honestly that full runtime verification needs a device/simulator.
- [ ] Commit on the app's branch: `feat(app): store auth tokens in expo-secure-store on native`.

---

## Final verification (backend)

- [ ] `bun run test` — unit suite green (the intentional magic-link/rate-limit assertion updates accounted for).
- [ ] `bun run test:e2e` — e2e suite green (access-control matrix still passes).
- [ ] `bun run typecheck` — exit 0.

## Done criteria

- Production refuses to boot on weak secrets; refresh tokens last 60d.
- Security headers present; auth endpoints rate-limited; account existence not leaked.
- Anonymous ZIP downloads re-checked; `?token=` JWT removed; admin uploads validated; presigned-URL cache scoped; legacy endpoint gone.
- App stores tokens in SecureStore on native with transparent migration.

## Notes / risks

- If any audit finding turns out to be already-fixed or the code has moved on, note it and skip — do not invent work.
- The H1 magic-link change and rate-limiting are the behaviour-changing items; the WS1 e2e access-control suite and the unit auth tests are the safety net — keep them green, updating only the assertions that SHOULD change.
