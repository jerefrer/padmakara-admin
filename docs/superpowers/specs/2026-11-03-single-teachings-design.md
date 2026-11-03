# Single teachings: buy or get one event's recordings

Status: approved by Jérémy on 2026-11-03 ("vas-y directement, on demandera le feedback d'André une fois en ligne").
Mockup (reference only, not binding): https://claude.ai/artifact/6R4r4NtqgRwh4hH2Rfm6D1

## Why

After an event, Padmakara emails attendees a link to a Wix form ("Retiros de Outono 2026"): first name, last
name, email, a consent checkbox, €15 per retreat, paid by Multibanco / MB WAY through Easypay. Once the
recordings are ready, someone sends them by hand to everyone who paid. We replace that with direct purchase on
app.padmakara.pt: the buyer pays, gets an account automatically, and the recordings appear in the app (web,
iOS, Android) for good.

## Decisions

- **Access**: buying (or being given) an event gives that person everything of the event (audio, videos,
  transcripts, documents), forever, regardless of membership status or audience.
- **Per-event sale mode**, set in the backoffice: `none` (default; nobody else can get it), `free` (anyone can
  add it to their account with just their email), `paid` (price in euros, prefilled with the default €15
  when switching to paid, editable per event).
- **One event per order** (v1). Several events = several purchases.
- **Retreat groups**: members keep access through their groups as today. A non-member may buy a single event
  of a group like any other event. No whole-group purchase. (André's options A + B; to confirm with him.)
- **Benefactor members**: per event, the admin chooses whether the teaching is included in the membership
  (`included_in_membership`, default false). When included, members with an active membership get access
  whatever the audience, with no grant row; the sale page says 'Included for benefactor members' and
  signed-in active members see 'Included in your membership' with an Open button instead of the form.
  Decided by André, option C.
- **Payment methods**: from config `EASYPAY_SINGLE_METHODS` (default `mb,mbw`). Card (`cc`) is added there
  once Easypay activates it (Easypay, 2026-10-29: card and direct debit wait for a signed amendment).
- **Accounts**: the buyer's email finds or creates a user (active, not verified, preferred language = the
  form's language). The buyer signs in later with the usual magic link / 6-digit code.
- **Emails** go out in the language of the form (pt or en).
- **Unpublished events can be sold**: the link works before the recordings are published. Access is stored
  immediately; the event appears in the buyer's app when it is published (the status gate is unchanged).
- **Native apps never show a price, a buy button or a link to buy** (Apple reader-app and Google Play rules).
  Purchase pages exist on web only. Native shows what the user has, and a neutral contact line.
- **Manual access**: admins give access by email (one per line) from the event page: hardship, gifts, payment
  made another way. Optional email to them.

## Data model (API, one migration)

- `events` (table `retreats`): `sale_mode text not null default 'none'` (none|free|paid),
  `price_cents integer` (null unless paid), `included_in_membership boolean not null default false`.
- New `event_access_grants`: `user_id` (FK users, cascade), `event_id` (FK retreats, cascade),
  `source text not null` (purchase|free|manual), `order_id integer null` (FK teaching_orders, set null),
  `granted_by integer null` (FK users, set null; the admin for manual), `created_at`. PK (user_id, event_id).
  Inserts use ON CONFLICT DO NOTHING (an existing grant wins).
- New `teaching_orders`: `id serial`, `public_id uuid unique default gen_random_uuid()` (used in URLs, never
  the serial id), `event_id`, `user_id`, `email`, `first_name`, `last_name`, `language`, `amount_cents`,
  `status text` (pending|paid|failed|expired|cancelled), `easypay_checkout_id`, `easypay_payment_id`,
  `method` (mb|mbw|cc…, when known), `created_at`, `paid_at`. Index on event_id, user_id, easypay ids.
- Default price: config `TEACHING_DEFAULT_PRICE_CENTS` (default 1500). No settings table (YAGNI).

## Access check

`checkEventAccess`: right after the admin bypass, a row in `event_access_grants` for (user, event) allows
access whatever the audience and subscription. Everything else is unchanged. `filterAccessibleEvents` gets
the same behaviour; it should load the user's grants once per call, not once per event.

## API

Public (no auth), under `/api/teachings`:
- `GET /:eventId` → `{ id, titleEn, titlePt, startDate, endDate, imageUrl, teachers[], places[], sessionCount,
  published: boolean, saleMode, priceCents, includedInMembership: boolean }`. 404 when saleMode is none or the event is archived.
- `POST /:eventId/checkout` body `{ email, firstName, lastName, language: "pt"|"en", consent: true }`
  (zod; consent must be true). IP rate-limited like the auth routes.
  - Finds or creates the user. If they already have access to the event (grant, group, admin…) → 409
    `ALREADY_HAS_ACCESS` (the page tells them to sign in).
  - `free`: grant (source free), bump the user's sync version, send the "available" email, return
    `{ status: "granted" }`.
  - `paid`: create a pending order, create an Easypay checkout `type: ["single"]`, `payment.methods` from
    config, `payment.key = "teaching-order-<publicId>"`, `payment.capture.descriptive` "Padmakara",
    `order.items[0] = { description: event title, quantity: 1, key: "event-<id>", value }`,
    `order.key = "teaching-order-<publicId>"`, `customer { name, email, key: "user-<id>", language }`.
    Store the checkout id. Return `{ status: "checkout", orderId: publicId, checkout: { id, session },
    testing }` for the web Easypay SDK (same shape the membership pay page uses).
  - Mock mode (no Easypay account configured): mark the order paid immediately (dev only).
- `GET /orders/:publicId` → `{ status, eventId, method, amountCents, mbReference?: { entity, reference,
  amount } }`. If still pending and older than ~10 s, it re-reads Easypay (checkout → single payment) and
  finalizes if paid, so the page does not depend on the webhook alone.

Authenticated: `GET /api/teachings/mine` → events the user has a grant for (published only, list shape of
`GET /api/events`), newest grant first.

Webhook (`POST /api/payment/webhook`, existing): keep the subscription path exactly as is. Before it, when
the notification is not a subscription one (the `/subscription/:id` lookup is not attempted for these):
recognise single payments by reading `GET /single/:id`; if its `key` (or order key) is
`teaching-order-<publicId>`, verify status and amount, then `finalizeOrder`. The existing
`payment_transactions` dedupe row is still written for audit. Exact field names of the single-payment
response MUST be checked against Easypay docs / a sandbox call, not guessed (we were burned before: see the
"Easypay API 2.0 field mapping" note in payment.ts).

`finalizeOrder(order, payment)` (idempotent): status paid, paid_at, method, payment id; grant (source
purchase, order id); `bumpUserAccessVersion`; send the "available" email once. Failed/expired payment →
order status failed/expired, no grant.

Admin (`/api/admin`, admin auth):
- Event PUT accepts `saleMode` and `priceCents` (paid requires a price ≥ 100 cents).
- `GET /events/:id/access` → `{ grants: [{ userId, email, name, source, orderId, amountCents, createdAt }],
  pendingOrders: [...], stats: { paidCount, collectedCents, pendingCount } }`.
- `POST /events/:id/access` `{ emails: string[], notify: boolean, language?: "pt"|"en" }` → find-or-create
  each user, manual grant, bump sync, optional email. Returns `{ added, alreadyHad, invalid }`.
- `DELETE /events/:id/access/:userId` → remove the grant (not group access), bump sync.

Emails (new builder next to membership-emails.ts, `renderBrandEmail`, pt/en):
- "Your recordings": event title; if published: "They are in your account on app.padmakara.pt and in the
  Padmakara app. Sign in with this email address." with a button to app.padmakara.pt; if not yet published:
  "We'll let you know as soon as they are online" (the publish notification itself is out of scope for v1).
- Manual grant uses the same email.
- Multibanco: Easypay shows the reference in its checkout; our confirmation page also shows it while pending.

## Web app (padmakara-app, web only)

- New route `/get/[id]` (native: redirect to home). Sections: event card (image, title, dates, teacher,
  place, "x sessions"; "Recordings coming soon" when unpublished), price, form (first name, last name, email;
  prefilled and email locked when signed in), consent checkbox ("I agree that Associação Padmakara processes
  my data to give me access to these recordings." / PT), hardship line ("Can't afford it? Write to
  info@padmakara.pt"), submit. Free: "Get the recordings" button, then the done state. Paid: Easypay inline
  checkout via the existing `EasypayCheckout.web.tsx`, then `/get/[id]/done?order=` which polls
  `GET /orders/:publicId`: paid → "Thank you, the recordings are in your account" (+ sign-in button if signed
  out); pending MB → reference + "We'll email you when your payment is confirmed"; failed → retry.
- Already has access (409) → "You already have these recordings: sign in" / open them.
- Style: the membership pages (EB Garamond small-caps red title, rows with rules, square burgundy button).
- All text in locales en/pt. Never the words subscription/subscribe/assinatura/subscrição.

## Retreats screen ("Your content"), all platforms

- Keep the screen; above or below "Your retreats" (groups) add a "Teachings" / "Ensinamentos" section listing
  `GET /api/teachings/mine` (cached like the other lists; refreshed on the user sync version).
- Empty state (no groups and no teachings) replaces "contact your administrator": a sentence explaining that
  retreat recordings are for participants of retreat groups, then a card "Did you attend a retreat? Write to
  us and we'll add you" with a mailto to info@padmakara.pt prefilled with the account email. Same on native
  (it is not a purchase). Nothing about buying or membership on native.

## Backoffice (admin)

- Event edit page, new section "Access & sale" right after "Event Details": radio None / Free / Paid
  (switching to Paid fills €15 if empty), price field, the shareable link `https://app.padmakara.pt/get/<id>`
  with Copy, stats (sold, collected, waiting for payment).
- Same page, section "People with access": list of grants (name, email, how: paid €15 · MB WAY / free /
  given by <admin>, date, Remove) plus pending orders; a "Give access by hand" box (emails, one per line;
  "Email them" checkbox; language select pt/en).
- i18n en/pt.

## Out of scope (v1)

Bundles / several events per order, member price, whole-group purchase, refunds UI, notifying buyers when an
unpublished event gets published, in-app (native) purchase or links, invoices.

## Testing

API: route tests for every endpoint (happy path, validation, 404/409, auth), webhook single-payment branch
(paid, failed, duplicate, unknown key, amount mismatch → not granted), finalizeOrder idempotency, access check
with a grant on each audience type. Admin and app: component tests for the new sections and pages, following
existing test styles. Verification commands: API `bunx --bun vitest run`, `bun run typecheck`
(5 pre-existing errors), `cd admin && bunx --bun vitest run`, `cd admin && bun x vite build`; app
`npx jest --no-watchman`, `npx tsc --noEmit` (13 pre-existing errors).
