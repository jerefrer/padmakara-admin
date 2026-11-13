# Membership-optional access conditions + batch participants / group members

> Execute task by task; tests first. Commit after each task (Conventional Commits,
> trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

**Goal:** (A) let an event be opened to account holders, group members or participants
*without* requiring an active membership; (B) add participants to an event and members
to a user group in batch, by pasting a list of emails.

**Requested by André (2026-11-12/13, APP BACKOFFICE).** Confirmed: "Every Member, not
necessarily active" = anyone with an app account. Accounts are created automatically for
pasted emails that have none (same as the existing "give access by hand" box).

## Global constraints

- Slugs are the contract between DB rows and access rules. Never match by id.
- Existing slugs keep their exact meaning (they require an active membership).
- No email is sent by batch adding.
- Admin UI strings in `admin/src/i18n/en.ts` and `pt.ts` (European Portuguese).
- Admin tests: `sh -c 'cd admin && bunx --bun vitest run'`; API tests: `bunx --bun vitest run`;
  typecheck both: `bunx tsc --noEmit -p .` and `sh -c 'cd admin && bunx tsc --noEmit -p .'`.
- TS rules: no `any` in new code, no non-null `!`, `as` only with a comment.

---

## Part A — membership-optional audiences

### Task A1: migration + access rules (API)

New audiences (custom migration via `bun run db:generate --custom --name membership_optional_audiences`):

| slug | name_en | name_pt | display_order |
|---|---|---|---|
| `account-holders` | Anyone with an account | Qualquer pessoa com conta | 2 |
| `retreat-group-members-no-membership` | User group members (membership not required) | Membros do grupo de utilizadores (adesão não obrigatória) | 5 |
| `event-participants-no-membership` | Event participants (membership not required) | Participantes no evento (adesão não obrigatória) | 4 |

SQL: `INSERT INTO audiences (name_en, name_pt, slug, display_order) VALUES … ON CONFLICT (slug) DO NOTHING;`
Apply locally with `bun db:migrate` (prod is applied by the controller, not you).

`src/services/access.ts`:
- Add to `AUDIENCE_SLUGS`: `ACCOUNT_HOLDERS`, `GROUP_MEMBERS_ANY`, `EVENT_PARTICIPANTS_ANY`.
- In `checkEventAccessWith`, after the paid-audience check and the on-request block, and
  **before** the `hasActiveSubscription` gate:
  - `ACCOUNT_HOLDERS` → allowed (any signed-in user).
  - `EVENT_PARTICIPANTS_ANY` → attendance row → allowed, else `EVENT_ATTENDANCE_REQUIRED`.
  - `GROUP_MEMBERS_ANY` → same rule as `GROUP_MEMBERS` (attendance, or no linked groups,
    or membership in a linked group) without the subscription; else `GROUP_MEMBERSHIP_REQUIRED`.
  - Extract the group rule into one helper used by both group slugs (no duplication).
- Update the access-model doc comment.
- `src/routes/groups.ts` `restrictToMemberships`: apply to both group slugs.
- Leave publications (`publication-access.ts`) untouched.

Tests in `tests/services/access.test.ts`: for each new slug — allowed without subscription
when the condition holds; denied with the right reason when it does not; unauthenticated →
`AUTH_REQUIRED`; existing slugs still require subscription (one regression test).
`tests/routes/admin/audiences.test.ts`: a new slug cannot be renamed (409).

### Task A2: admin chooser — "Requires an active membership" switch

`admin/src/components/EventAccessChooser.tsx`:
- Add `MEMBERSHIP_PAIRS` (exported):
  - `accounts`: required `free-subscribers`, optional `account-holders`
  - `groups`: required `retreat-group-members`, optional `retreat-group-members-no-membership`
  - `participants`: required `event-participants`, optional `event-participants-no-membership`
- Add `ACCESS_OPTIONS` entries for the three new slugs (group `free`, `canSell: true`,
  `groups: true` for the group one) with keys `accountHolders`, `groupsNoMembership`,
  `participantsNoMembership`.
- Rows in the "free" group: Everyone, then **one row per pair** (in the position of its
  required audience). Row title comes from i18n `padmakara.eventAccessChooser.pairs.<key>.title`
  ("Anyone with an account" / "User group members" / "Event participants"), description from
  `…pairs.<key>.desc`. A row is checked when the selected slug is either slug of its pair.
  Clicking a row selects the **required** variant (current default behaviour) unless the
  selection is already in that pair. Hide a pair row when neither audience exists.
- Right panel, when the selection is in a pair and both audiences exist: a Switch
  "Requires an active membership" (`requiresMembership`), checked for the required variant,
  with a hint line (`requiresMembershipHint`); toggling calls `onAudienceChange` with the
  other variant and keeps sale settings (`saleForChoice` between two canSell options keeps them).
- Panel title/description keep using the selected audience's name + `options.<key>.panel`;
  add `desc`, `panel`, `othersHint` texts for the three new keys.
- `frozen` (parallel retreats): enable both group slugs, nothing else.
- `admin/src/resources/events.tsx`: `showGroupsPicker` also true for
  `retreat-group-members-no-membership`. RET default stays `retreat-group-members`.
- `admin/src/resources/audiences.tsx` `BUILT_IN_SLUGS`: add the three new slugs.

Tests (`EventAccessChooser.test.tsx`): one row per pair; picking "Anyone with an account"
selects `free-subscribers`; the switch moves to `account-holders` and back; switch hidden for
Everyone; frozen allows both group variants.

---

## Part B — batch participants and group members

### Task B1: API

- Extract the email parsing in `src/routes/admin/event-access.ts` (trim, lowercase, dedupe,
  `invalid` list) into `src/services/email-list.ts` → `parseEmailList(raw: string[]): { valid: string[]; invalid: string[] }`,
  and use it in event-access.ts (behaviour unchanged; its tests must still pass).
- New `src/routes/admin/event-participants.ts`, mounted like event-access (under `/api/admin/events`):
  - `GET /:id/participants` → `[{ id, email, name, registeredAt }]` sorted by name then email.
  - `POST /:id/participants` body `{ emails: string[] (1..1000), language?: "pt"|"en" }` →
    for each valid email `findOrCreateUserByEmail`, insert `userEventAttendance`
    `onConflictDoNothing().returning()`; respond `{ added, alreadyHad, created, invalid }`
    (`created` = emails whose account was just created; they are also in `added`).
  - `DELETE /:id/participants/:userId` → 204, 404 when not a participant.
  - Call `bumpUserAccessVersion` for every user whose access changed (see how event-access.ts uses it).
- Same three routes for groups at `/api/admin/groups/:id/members` on `userGroupMemberships`
  (status default). Put them in `src/routes/admin/group-members.ts`, mounted like groups.
- 404 when the event/group does not exist; 400 `TOO_MANY_EMAILS` over 1000; admin-only like siblings.
- Tests: `tests/routes/admin/event-participants.test.ts`, `group-members.test.ts`, following
  `event-access.test.ts` mocking style — add/already/created/invalid split, dedupe, 404s, delete,
  non-admin 403.

### Task B2: admin UI

- New `admin/src/components/BatchMembersCard.tsx` (generic): props
  `{ endpoint: string; i18nPrefix: string }` (e.g. `/api/admin/events/12/participants`,
  `padmakara.participants` / `padmakara.groupMembers`). Data calls go through a small hook
  `useBatchMembers(endpoint)` (list, add, remove) using `authFetch`.
  - Textarea "Paste emails". Client splits on newlines, commas, semicolons, tabs and spaces,
    so a column or row copied from a spreadsheet works.
  - "Add" button → result summary: added (n), already there (n), **new accounts created**
    (listed by email, warning colour, with a hint "check these for typos"), invalid (listed).
  - Current list with count, a filter box when > 10, and a remove button per person that asks
    first with `ConfirmChangeDialog`.
- Event edit page: a "Participants" section right before the `EventAccessSection` block
  (same section style as its neighbours).
- Group edit page (`admin/src/resources/groups.tsx`): a "Members" section.
- i18n en + pt for every string.
- Tests `BatchMembersCard.test.tsx`: splitting a pasted spreadsheet column; summary shows the
  created accounts; remove asks for confirmation.

---

## Out of scope / flag

- Audience 17 "Member+Parcipant" (custom, unused) was created by hand in prod; leave it.
- Publications keep their current audience options.
