# Statistics page, server-side usage counts, and a personal message in the publish email

> Execute task by task; tests first. One commit per task (Conventional Commits,
> trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

**Requested by André (2026-11-13), approved by Jérémy.** Statistics: "everything you
mentioned, without further consent". No in-app analytics SDK, no consent screen, nothing
stored on the device. Personal message: "good to have that flexibility".

## Global constraints (privacy — non-negotiable)

- Only aggregates are shown. No per-person usage view anywhere in the admin.
- Server-side counting only, from requests the app already makes. No new data from the app.
- Daily activity rows (`user_active_days`) are the only per-user usage data added; they are
  kept 13 months, then deleted.
- No new dependency for charts: simple bars built with MUI `Box` (the admin has no chart lib).
- Admin strings en + pt (European Portuguese). App strings en + pt; never "subscription" etc.

---

## Task 1 (API): usage recording

Migration (`bun run db:generate --name usage_statistics`, `IF NOT EXISTS`):
- `usage_daily(day date, metric text, event_id integer not null default 0, count integer not null default 0)`,
  primary key `(day, metric, event_id)` (0 = not tied to an event).
- `user_active_days(user_id integer references users on delete cascade, day date)`,
  primary key `(user_id, day)`.

`src/services/usage.ts`:
- `countUsage(metric: UsageMetric, eventId?: number): void` — fire-and-forget upsert
  `count = count + 1` for today (Europe/Lisbon date); errors are logged, never thrown, never
  slow the request.
- `markActive(userId: number): void` — insert `(userId, today)` on conflict do nothing; an
  in-memory set per day avoids a DB write on every request.
- `pruneUsage(): Promise<void>` — delete `user_active_days` older than 13 months; run at
  startup and then every 24 h (`setInterval`, unref'd), from `src/index.ts`.
- Metrics (`UsageMetric` union): `transcript_open`, `file_open`, `readalong_open`,
  `video_start`, `video_download`, `zip_download`, `app_open`.

Hooks (each one line, after access was granted, never on error responses):
- `authMiddleware` / `optionalAuthMiddleware`: `markActive(user.id)` when a user is resolved.
- `media.ts`: `/transcript/:id` → `transcript_open`; `/file/:id` → `file_open`;
  `/readalong/:trackId` → `readalong_open`; HLS `master.m3u8` → `video_start`;
  `/video/:videoId/download` → `video_download`. Count only requests without a `Range`
  header or with a range starting at 0, so one open counts once. Resolve the event id the
  route already loads.
- ZIP: creating a download request → `zip_download` (event id).
- `app_open`: the app's sync/start call — find the endpoint the app calls on launch and
  foreground (look at padmakara-app `services/syncService.ts` / `apiService.ts`, read only)
  and count it there, at most once per user per hour (in-memory).
- Audio plays are **not** counted from `/media/audio` (range requests, offline): Task 2 reads
  `user_progress` (`playCount`, `totalListenSeconds`, `isCompleted`) instead.

Tests: `countUsage` upsert and swallow-on-error; `markActive` writes once per day; prune
deletes only old rows; one route test per hook (counted on success, not on 403/404, not on a
mid-file Range).

## Task 2 (API): `GET /api/admin/statistics?from=YYYY-MM-DD&to=YYYY-MM-DD`

Admin only. Default range: last 30 days. Returns:
- `accounts`: `{ total, newInRange, activeMembers }` (active membership = `hasActiveSubscription`).
- `activeUsers`: `{ last7, last30, inRange }` from `user_active_days` (distinct users).
- `monthly` (last 12 months, oldest first): `[{ month: "2026-11", signups, activeUsers,
  teachingSalesCents, membershipCents }]` — sales from paid `teaching_orders`, membership
  income from successful `payment_transactions` (read their schema; only count captured/paid).
- `platforms`: devices activated or used in the last 90 days by `device_type`.
- `events` (top 20 by listeners in range, published events): `{ id, title, listeners
  (distinct users with progress updated in range), completedTracks, listenHours,
  videoViewers (distinct users, video_progress), transcriptOpens, fileOpens, videoStarts,
  zipDownloads }` — opens/starts from `usage_daily`.
- `appOpens` per day in range (sum of `app_open`).
Tests with the mocked-db pattern for the shape and the range defaults; one test that no
email, name or user id appears in the response.

## Task 3 (admin): Statistics page

- New menu entry "Statistics" (pt "Estatísticas"), a custom page (look at how the searches
  page is registered in `admin/src/App.tsx`).
- Range picker: 7 days / 30 days / 90 days / 12 months.
- KPI tiles: accounts, new accounts, active members, active users (7 / 30 days).
- Monthly bars (12 months): sign-ups and active users; a second block for teaching sales and
  membership income (€).
- Platforms: iPhone / Android / web as horizontal bars with counts.
- Events table, sortable: listeners, completed tracks, listening hours, video viewers,
  transcript opens, downloads. Click a row → the event's edit page.
- A short note at the bottom: "Totals only. Counted on our server, no tracking in the app."
- Tests: renders tiles and table from a mocked response; range change refetches.

## Task 4 (API + admin): personal message in the "now available" email

- `POST /api/admin/events/:id/notify-published` accepts `message?: string` (trimmed, max
  1000 chars, plain text). `buildTeachingPublishedEmail` gains `message?: string`, rendered
  as its own paragraph after the intro (HTML-escaped by the template; keep line breaks).
- Publish dialog: under the ticked "Email the N people…" box, an optional multiline
  "Add a personal message (optional)" field (`data-testid="notify-message"`), shown only
  while the box is ticked; sent with the POST.
- Tests: message escaped and included; omitted when empty; over 1000 → 400; dialog sends it.

## Task 5 (app, `padmakara-app`): privacy policy

In `app/privacy-policy.tsx` (and the locale files it uses), add to the section on data
collected, in the file's tone:
- en: "Usage statistics. To understand how the app is used, our server counts, per day and
  per teaching, how often recordings, transcripts and documents are opened, and which days
  each account was active. These records are only used as totals, are never shared, and
  daily activity is deleted after 13 months. Nothing is tracked inside the app and no
  advertising or third-party analytics are used."
- pt: "Estatísticas de utilização. Para perceber como a aplicação é usada, o nosso servidor
  conta, por dia e por ensinamento, quantas vezes são abertas gravações, transcrições e
  documentos, e em que dias cada conta esteve ativa. Estes registos só são usados como
  totais, nunca são partilhados, e a atividade diária é apagada ao fim de 13 meses. Nada é
  seguido dentro da aplicação e não usamos publicidade nem análises de terceiros."
- `npx tsc --noEmit` on the file's area, no EAS build.
