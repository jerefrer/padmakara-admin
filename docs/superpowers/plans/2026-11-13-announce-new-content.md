# "Announce new content": the second email of an event

> Execute task by task; tests first. One commit per task (Conventional Commits,
> trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

**Requested by André (2026-11-13), approved by Jérémy.** Padmakara tells people twice per
event: first when the audio is published (already built: the "Email the N people…" box in the
publish confirmation), then when the transcripts and the videos with subtitles are ready.
The second one is a manual button so transcripts and videos ready a few days apart can still
go out as one email.

## Global constraints

- Recipients are exactly `listEventRecipients(eventId)` (same as the publish email).
- Never announce content the app does not show: a kind can be chosen only when its
  "Show in app" flag is on and the section has content.
- Each kind is announced at most once per event (no duplicates), unless `force`.
- Admin strings en + pt (European Portuguese). Email copy en + pt. Never "subscription".
- Reuse what exists: `sendPublishedEmails`' sending loop pattern (≥ 100 ms apart, per-user
  language, log failures), `renderBrandEmail`, `ConfirmChangeDialog` look, the publish
  dialog's optional message field.

## Task 1 (API)

- Migration `bun run db:generate --name event_announcements` (`IF NOT EXISTS`):
  `event_announcements(id serial pk, event_id integer not null references retreats on delete cascade,
  kinds text[] not null, message text, recipient_count integer not null, sent_by integer references users on delete set null,
  sent_at timestamptz not null default now())`, index on `event_id`.
- Kinds: `"transcripts" | "videos" | "texts"`, mapped to the flags `transcriptsPublished`,
  `videoPublished`, `textsPublished` and to content: transcripts = transcripts + read-along
  tracks, videos = event videos, texts = event files + linked publications (reuse how the
  admin/API already counts these if a helper exists).
- `buildContentAnnouncementEmail({ lang, firstName, eventId, eventTitle, kinds, message? })`
  in `teaching-emails.ts`:
  - subject en "New on <title>" / pt "Novidades: <title>";
  - intro en "<List> of <title> are now available." / pt "<List> de <title> já estão disponíveis.",
    where the list joins, in this order, en "The transcripts" / "the videos with subtitles" /
    "the related texts" (first item capitalised, "and" before the last, Oxford comma not used)
    and pt "As transcrições" / "os vídeos com legendas" / "os textos relacionados" ("e");
  - then the optional message paragraph, the same access paragraph and the same button
    (`/retreat/<id>`) as the published email.
- Routes (mounted like `event-notify.ts`, admin only):
  - `GET /api/admin/events/:id/announcements` → `{ recipients: number, published: { at, count } | null,
    kinds: [{ kind, available: boolean, reason?: "hidden" | "empty", announcedAt: string | null }],
    history: [{ kinds, sentAt, count, message }] }` (newest first).
  - `POST /api/admin/events/:id/announce` body `{ kinds: Kind[] (min 1), message?: string (trim, ≤ 1000), force?: boolean }`
    → 409 `EVENT_NOT_PUBLISHED`; 400 `KIND_NOT_AVAILABLE` when a kind is hidden or empty;
    409 `ALREADY_ANNOUNCED` (with the kinds) unless `force`; inserts the row, answers
    `{ queued: n }` at once, sends in the background. No row when n = 0.
- Tests: email copy (1, 2, 3 kinds; en/pt; message; link); routes (each error, history order,
  insert row, background send called with the kinds and message).

## Task 2 (admin)

- On the event edit page, next to the status toggle, an outlined button
  "Announce new content" (pt "Anunciar novos conteúdos"), only when the event is published.
- Dialog (loads `GET …/announcements` when opened):
  - one checkbox per kind: "Transcripts", "Videos with subtitles", "Related texts";
    disabled with a reason ("Not shown in the app yet" / "Nothing here yet") when not available;
    "Already announced on <date>" under a kind already sent (unticked by default, still
    tickable — ticking it sends with `force`, after the dialog says it will be sent again);
  - available, not-yet-announced kinds start ticked;
  - "N people will get the email"; the optional personal message field (same as publish);
  - a short history list ("Recordings: 13 Nov · 4 people", then each announcement).
  - Confirm → POST, notification "Emailing N people", dialog closes.
- Tests: kinds states (available / hidden / empty / announced), default ticks, POST body
  (kinds, message, force only when re-sending), button hidden unless published.
