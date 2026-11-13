# "Forthcoming" event status + "now available" email on publish

> Execute task by task; tests first. One commit per task (Conventional Commits,
> trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

**Goal:** (1) a third event status, `forthcoming`, between `draft` and `published`: the
event shows in the app, to the people who will have access, as "Forthcoming – this event is
being edited", with no content open; (2) when an event is published, the admin can email
everyone who has access that it is now available.

**Requested by André (2026-11-13), approved by Jérémy.** It also keeps the promise of the
purchase email sent for an unpublished teaching ("We'll let you know as soon as they are
online"), which nothing fulfils today.

## Global constraints

- Content (sessions, tracks, audio/video URLs, transcripts, files, downloads) opens only for
  `published` (and for admins, as today). `forthcoming` only adds visibility in lists/detail.
- Apple Reader rules in the app: never "subscription/subscribe/subscrição/subscrever/assinatura";
  no prices or payment links.
- Admin and app strings: en + pt (European Portuguese).
- Prod is deployed by the controller, never by you.

---

## Task 1 (API): `forthcoming` status

- Zod `status` enum (`src/lib/schemas.ts` ~256) accepts `forthcoming`.
- `src/services/access.ts`:
  - `eventStatusVisibleTo(role)` (listing/detail): non-admin `["published","forthcoming"]`,
    admin `["published","forthcoming","draft"]`.
  - New `eventStatusOpenTo(role)` (content): non-admin `["published"]`, admin
    `["published","forthcoming","draft"]`.
  - The status gate in `checkEventAccessWith` uses `eventStatusOpenTo`. Add an option so
    `filterAccessibleEvents` (lists) evaluates the audience of a forthcoming event as if
    published (status gate with `eventStatusVisibleTo`). Single-event content checks stay strict.
- Audit **every** call site listed by `grep -rn -E 'published|eventStatusVisibleTo|checkEventAccess|filterAccessibleEvents' src/routes src/services`
  and decide list-vs-content for each:
  - Lists include forthcoming events the user would have access to: `routes/events.ts`
    lists, `routes/groups.ts` (group list + group events), `routes/teachings.ts` /mine,
    `routes/search.ts` event hits (but no track/transcript hits from forthcoming events).
  - `GET /api/events/:id` for a forthcoming event (non-admin with access): returns the event
    metadata (title, dates, teachers, place, groups, images, description) with
    `status: "forthcoming"`, `sessions: []` and every media/publication/file array empty.
    No access → same 404/403 as today.
  - `content.ts`, `media.ts`, `downloads.ts`, public event routes (`/public`, `/featured`,
    the free-subscribers preview ~line 342): unchanged, published only.
  - Home highlight stays published-only (`admin/events.ts` ~368, ~514).
- Every event payload sent to the app must carry `status` (check list items too).
- Tests: forthcoming listed for a user with access and not for one without; detail strips
  content; presigned/track/transcript/download routes deny a forthcoming event (404 like
  draft); admin still opens content; search excludes forthcoming track hits.

## Task 2 (API): recipients + "now available" email

- Migration (`bun run db:generate --name event_publish_notification`): on `retreats` add
  `published_notified_at timestamptz` and `published_notified_count integer`.
- `src/services/event-recipients.ts`: `listEventRecipients(eventId): Promise<Recipient[]>`
  (`{ id, email, firstName, preferredLanguage }`), users who can open the event once published:
  - active accounts only (`isActive`), excluding the store-review account (`config` review email);
  - by audience slug: `free-anyone` / `account-holders` → all; `free-subscribers` → active
    membership (`hasActiveSubscription`); group slugs → members of the event's groups ∪
    attendees (everyone when no group is linked), plus membership when the slug requires it;
    participant slugs → attendees (+ membership when required); paid / on-request /
    initiation / restricted / custom → nobody from the audience;
  - ∪ users holding an `event_access_grants` row; ∪ active members when `includedInMembership`
    and the audience is not paid; deduplicated.
  - Unit tests per audience, against the access rules (a recipient must pass `checkEventAccess`
    for the published event — add one test that asserts this on a fixture set).
- `src/services/teaching-emails.ts`: `buildTeachingPublishedEmail({ lang, firstName, eventTitle })`
  — subject pt "Já disponível: <title>" / en "Now available: <title>"; intro pt
  "As gravações de <title> já estão disponíveis." / en "The recordings of <title> are now available.";
  second paragraph and button = the `published` branch of `buildTeachingAvailableEmail`.
- Admin routes (in `routes/admin/events.ts` or a new file mounted the same way):
  - `GET /api/admin/events/:id/recipients` → `{ count, notifiedAt, notifiedCount }`.
  - `POST /api/admin/events/:id/notify-published` body `{ force?: boolean }` → 409
    `EVENT_NOT_PUBLISHED` unless published; 409 `ALREADY_NOTIFIED` when `published_notified_at`
    is set and not `force`. Sets both columns, responds `{ queued: n }` at once, then sends
    in the background one by one (≥ 100 ms apart, SES rate), each user's language, logging
    failures without stopping.
- Tests for both routes and the email builder.

## Task 3 (admin)

- `EventStatusControls`: three-way toggle Draft / Forthcoming / Published.
  Confirmations: forthcoming uses new copy ("Show as forthcoming? The event will appear in the
  app as 'Forthcoming – being edited' to the people who will have access, without its
  content."); publish keeps the section boxes and adds, below them, a checkbox
  "Email the N people who have access that it's now available" (`data-testid="notify-on-publish"`),
  checked by default, N fetched from `/recipients` when the dialog opens; hidden when N = 0
  or when already notified (then show "Already emailed on <date>"). On confirm with the box
  ticked, after the status is saved, POST `notify-published` and show a notification
  "Emailing N people".
- The section boxes / "Hidden in the app" badge treat forthcoming like draft (no badge).
- Create wizard: the toggle offers the three statuses; no email from the wizard (event has no
  recipients yet worth emailing — keep it simple, note it).
- Events list: status chip/filter shows forthcoming (find where draft/published are shown).
- Tests: three-way toggle, forthcoming confirmation, notify box default/hidden cases, POST sent
  only when ticked.

## Task 4 (app, `padmakara-app`) — contract

Events from the API may now have `status: "forthcoming"`; such an event has empty
`sessions` and media arrays.
- Event cards/lists: a small "Forthcoming" badge (pt "Em breve"), styled like existing badges.
- Event screen: header/metadata as usual, then instead of sessions a calm notice
  "Forthcoming – this event is being edited and will be available soon." (pt "Em breve – este
  evento está a ser editado e ficará disponível em breve."); no download, no play, no
  "missing content" error states.
- i18n in `locales/en.json` and `pt.json` with `t()` fallbacks.
- Tests where the repo has them for these screens; `npm run lint` and `npx tsc --noEmit` clean.
- Do not run any EAS build.
