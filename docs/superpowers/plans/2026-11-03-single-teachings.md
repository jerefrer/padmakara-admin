# Single Teachings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell (or give) one event's recordings on app.padmakara.pt and show them in the buyer's app.

**Architecture:** A per-user, per-event grant table bypasses audience/subscription checks. Orders are paid through
an Easypay `single` checkout (Multibanco / MB WAY now, card later via config) and finalized from the webhook or
from order polling. Admin sets sale mode and gives access; the web app has a public `/get/[id]` page; every
platform lists granted events on the Retreats screen.

**Tech Stack:** API Hono + Drizzle + Zod v4 + Vitest (Bun); admin React-admin + MUI + Vite; app Expo Router + Jest.

**Spec:** `docs/superpowers/specs/2026-11-03-single-teachings-design.md` (read it first; it is the source of truth for
copy, field names and behaviour).

## Global Constraints

- Two repos: API+admin at `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api`, app at
  `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app`. One feature branch per repo:
  `feature/single-teachings`, in a git worktree under each repo's `.claude/worktrees/`. Never touch uncommitted work
  in the main checkouts. Copy node_modules into worktrees with `cp -cR`; never modify the main checkouts' node_modules.
  Use `/usr/bin/git`.
- Migrations only via `bun run db:generate --name single_teachings` (commit SQL + snapshot + journal); review the SQL;
  never `db:push`. Do not apply anything to production.
- English for code, comments, commits. All UI text through i18n (admin en.ts/pt.ts; app locales/en.json + pt.json,
  European Portuguese). Never "subscription/subscribe/assinatura/subscrição" in app UI.
- Native app (iOS/Android): no price, no buy button, no link to a purchase page. `/get/*` routes redirect home on native.
- Easypay single-payment response field names must be confirmed from Easypay docs (context7 library
  `/websites/easypay_pt`) — never guessed. Keep the existing subscription webhook path behaviour unchanged.
- Commits: Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_014fTT7HioX2cCSYhm9BZxWp`.
- Verification: API `bunx --bun vitest run` (never `bun test`), `bun run typecheck` (exactly 5 pre-existing errors:
  media.ts, admin/publications.ts ×3, admin trackParser.ts), `cd admin && bunx --bun vitest run`,
  `cd admin && bun x vite build`; app `npx jest --no-watchman` from the app worktree, `npx tsc --noEmit`
  (13 pre-existing errors). Do not push, merge or deploy.

## Review Focus

- A webhook for an unrelated single payment (not `teaching-order-…` key) must be recorded and ignored, never grant.
- Amount paid ≠ order amount → order not finalized, logged.
- The same notification delivered twice, or webhook + polling racing → one grant, one email.
- Buyer email that already belongs to a user (any case/whitespace variant) → same user reused, no duplicate account.
- Grant on a `draft` event → no access until published (status gate first); appears after publication.

---

### Task 1: Grants, sale columns, access check (API)

**Files:** Modify `src/db/schema/retreats.ts`, `src/db/schema/index.ts`; create `src/db/schema/event-access.ts`
(`eventAccessGrants`, `teachingOrders` + relations); migration via db:generate; modify `src/services/access.ts`;
tests `tests/services/access-grants.test.ts`.

**Interfaces — Produces:**
- `events.saleMode: "none"|"free"|"paid"`, `events.priceCents: number|null`.
- `eventAccessGrants`, `teachingOrders` tables exactly as in the spec.
- `hasEventGrant(userId: number, eventId: number): Promise<boolean>` in `src/services/access.ts`.
- `checkEventAccess` allows when a grant exists (after status gate and admin bypass, before audience rules);
  `filterAccessibleEvents` loads the user's granted event ids once.

- [ ] Write failing tests: grant allows on each non-public audience with no subscription; draft still hidden; no grant
  → old behaviour; filterAccessibleEvents does one grant query.
- [ ] Implement schema + migration (`IF NOT EXISTS`), access changes. Run tests, typecheck. Commit
  `feat(access): per-event access grants and sale settings`.

### Task 2: Shared helpers — config, user lookup, email (API)

**Files:** `src/config.ts` (`teachings: { defaultPriceCents, singleMethods: string[] }` from
`TEACHING_DEFAULT_PRICE_CENTS`=1500, `EASYPAY_SINGLE_METHODS`="mb,mbw"); create `src/services/users-lookup.ts`;
create `src/services/teaching-emails.ts`; tests.

**Produces:**
- `findOrCreateUserByEmail(input: { email: string; firstName?: string; lastName?: string; language: "pt"|"en" }):
  Promise<{ user: { id: number; email: string; preferredLanguage: string }; created: boolean }>` — trims/lowercases
  email, case-insensitive match, new user active, not verified, role user. Reuse in `admin/approvals.ts` only if trivial; otherwise leave it.
- `buildTeachingAvailableEmail(input: { lang: "pt"|"en"; firstName?: string|null; eventTitle: string; published: boolean }):
  { subject: string; html: string; text: string }` via `renderBrandEmail`, copy per spec.
- `grantEventAccess(input: { userId; eventId; source: "purchase"|"free"|"manual"; orderId?; grantedBy? }):
  Promise<{ created: boolean }>` (ON CONFLICT DO NOTHING; bumps `bumpUserAccessVersion` when created) in
  `src/services/event-access.ts`.

- [ ] Tests first (email copy pt/en and published/unpublished; findOrCreate reuse with `  Foo@X.pt `; grant idempotent).
- [ ] Implement, run, commit `feat(teachings): access grant, user lookup and email helpers`.

### Task 3: Public teaching routes + Easypay single checkout (API)

**Files:** create `src/routes/teachings.ts`, `src/services/teaching-orders.ts`; mount in `src/routes/index.ts`;
schemas in `src/lib/schemas.ts`; tests `tests/routes/teachings.test.ts`.

**Consumes:** Task 1–2 interfaces; `easypayFetch`/`isMockMode` from `src/routes/payment.ts` (export them if needed,
without behaviour change).

**Produces:**
- Routes `GET /api/teachings/:eventId`, `POST /api/teachings/:eventId/checkout`, `GET /api/teachings/orders/:publicId`,
  `GET /api/teachings/mine` exactly as in the spec (rate limit checkout with the same limiter auth routes use).
- `finalizeOrder(orderId: number, payment: { paymentId: string; method?: string; amountCents: number }):
  Promise<"finalized"|"already"|"amount_mismatch">` in `src/services/teaching-orders.ts` (transactional status update
  `WHERE status='pending'` so only one caller wins; grant; email once).
- `refreshOrderFromEasypay(order): Promise<void>` used by the order status route.

- [ ] Tests first: preview 404 for none/archived; checkout validation (consent false → 400); free grants + email;
  paid creates order + calls Easypay with methods from config, key `teaching-order-<publicId>`; 409 when the user
  already has access; mock mode marks paid; order status shape; mine lists published granted events only.
- [ ] Implement, run, typecheck, commit `feat(teachings): public sale page API and single-payment checkout`.

### Task 4: Webhook single-payment branch (API)

**Files:** modify `src/routes/payment.ts` (webhook only); tests `tests/routes/payment-webhook-single.test.ts`.

**Consumes:** `finalizeOrder`.

- [ ] Confirm the `/single/:id` response fields (status, key, value, method, MB entity/reference) from Easypay docs.
- [ ] Tests first: paid single with our key → finalized; failed status → order failed; unknown key → recorded, ignored;
  amount mismatch → not granted; duplicate → one grant; subscription notifications unchanged (existing tests still pass).
- [ ] Implement: decide subscription vs single before the subscription lookup (by notification type and/or by trying
  `/single/:id` when the subscription lookup is not applicable), record the `payment_transactions` row as today.
  Commit `feat(payment): finalize teaching orders from single-payment notifications`.

### Task 5: Admin API — sale settings and access management

**Files:** `src/routes/admin/events.ts` (PUT accepts saleMode/priceCents, GET returns them), create
`src/routes/admin/event-access.ts` mounted under events; tests.

**Produces:** `GET/POST /api/admin/events/:id/access`, `DELETE /api/admin/events/:id/access/:userId` per spec
(POST caps 200 emails, validates each, returns `{ added, alreadyHad, invalid }`).

- [ ] Tests first (auth 401/403, validation, paid requires price ≥ 100, grant listing with order info, delete bumps
  sync), implement, commit `feat(admin): event sale settings and access management API`.

### Task 6: Admin UI — "Access & sale" and "People with access"

**Files:** create `admin/src/components/EventSaleSection.tsx`, `admin/src/components/EventAccessSection.tsx`; wire in
`admin/src/resources/events.tsx` after Section 1 (edit view only for access list; sale settings in form data
`EventFormData`/`EMPTY_FORM`); i18n en/pt; tests.

- [ ] Component tests first (Paid fills 15.00 when empty; link shows `https://app.padmakara.pt/get/<id>` with Copy;
  give-access posts trimmed emails + notify; Remove calls DELETE). Implement in the admin's existing style (white
  cards, SectionHeader, red icons). Build. Commit `feat(admin): access and sale sections on the event page`.

### Task 7: App — web purchase page

**Files (padmakara-app):** `app/get/[id].tsx`, `app/get/[id]/done.tsx` (or a `_layout` stack under `app/get/`),
`services/teachingService.ts`, `services/apiConfig.ts` endpoints, locales, tests.

**Consumes:** API routes from Task 3; `components/membership/EasypayCheckout(.web).tsx`; membership theme.

- [ ] Tests first: native redirects home; form validation and consent; free path shows done state; 409 shows sign-in
  message; done page renders paid / pending-with-MB-reference / failed from mocked order status.
- [ ] Implement (web-only UI, membership page style), commit `feat(app): web page to get a teaching's recordings`.

### Task 8: App — teachings on the Retreats screen + new empty state

**Files:** `app/(tabs)/(groups)/retreats/index.tsx`, `services/retreatService.ts` (or teachingService) with caching
like the other lists and refresh on user sync version, locales, tests.

- [ ] Tests first: section lists teachings from `/teachings/mine`; empty state shows the explanation + mailto to
  info@padmakara.pt with the account email; no price/buy/link on native (assert by Platform mock).
- [ ] Implement, commit `feat(app): teachings section and helpful empty state on the Retreats screen`.
