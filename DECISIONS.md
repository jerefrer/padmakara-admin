# Decisions

## 2026-05-15 — Anonymous event ZIP downloads

**Chosen:** Anonymous (unauthenticated) ZIP download requests for public events are addressed by an unguessable UUID request id, and the event's public status is re-verified at every status check and download. If the event is no longer public, the download is denied even if the request id is known.
**Alternatives:** Require authentication for all downloads; or rely solely on UUID secrecy with no re-check.
**Why:** Public-event content is already public, so UUID-addressed access is acceptable; re-verification closes the window where a since-restricted event's ZIP stays reachable via a stale request.
**Trade-offs:** A leaked request id exposes a still-public event's ZIP (acceptable — the content is public).
**Revisit if:** anonymous downloads are extended to non-public content.

---

## 2026-07-14 — Video playback security (Bunny Stream)

**Chosen:** Maximum security for video, enforced by three independent layers:

1. **Backend access gate (who may watch).** `GET /api/media/video/:sessionVideoId` runs `checkEventAccess()` (`src/services/access.ts`) before issuing anything. Non-public events require authentication; subscriber / group-member / event-participant audiences require `hasActiveSubscription()` — which checks **both** `subscriptionStatus === "active"` **and** `subscriptionExpiresAt >= now`. A lapsed member gets no new playback token. (Sensitive events must therefore be assigned a subscription-gated audience — NOT `public` — in the admin.)
2. **Media Access Token (MAT).** On success the backend issues a short-lived (~4h) JWT scoped to `userId + sessionVideoId + bunnyVideoId + expiry`. The app appends `?mat=` to every HLS-proxy request; the proxy verifies it and signs Bunny URLs on the fly, 302-redirecting segments (Bunny→user direct, no bandwidth on our server).
3. **Bunny CDN token authentication (protects leaked URLs).** The Bunny pull zone has **Token Authentication ENABLED**. Every CDN URL is signed + time-limited; a leaked/shared URL 403s once it expires and cannot be reused for another video. Signing (`signCdnPath` in `src/services/bunny.ts`) = `base64url(sha256(tokenAuthKey + exactPath + expires))` — **exact-URL only** on this pull zone (directory/`token_path` tokens are rejected; verified empirically 2026-07-14).

**Required Bunny config (pull zone `vz-e1a59eba-cf6`, id 6151330; Stream library "Padmakara App", id 703816):**
- Pull zone → Security → **Token Authentication: ON**. Its `ZoneSecurityKey` MUST equal the API's `BUNNY_STREAM_TOKEN_AUTH_KEY`.
- Library → **Enable direct play: ON**, Block-direct-url: OFF, Embed-view-token: OFF (playback goes through the proxy, not the iframe).
- Bunny webhook URL = `https://api.padmakara.pt/api/webhooks/bunny?secret=<BUNNY_WEBHOOK_SECRET>` (backfills `session_videos.duration_seconds`).
- API env: `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY` (library API key), `BUNNY_STREAM_CDN_HOSTNAME`, `BUNNY_STREAM_TOKEN_AUTH_KEY` (= pull-zone ZoneSecurityKey), `BUNNY_WEBHOOK_SECRET`.
- API `secureHeaders` sets `Cross-Origin-Resource-Policy: cross-origin` so the web app (app.padmakara.pt) can load media from the API (api.padmakara.pt) — access is gated by JWT/MAT, not CORP.

**Alternatives:** CDN token auth OFF (simpler; relies only on the backend gate + unguessable GUIDs) — rejected because content is sensitive and a leaked URL would then be replayable forever.

**Why:** Content is private and subscription-funded; a leaked CDN URL must expire and access must stop the moment a subscription lapses.

**Trade-offs:** More Bunny config to keep in sync. The signing code itself is standard and stable — the two prod outages were caused by (a) the Bunny library being deleted/recreated during a content wipe, which reset the pull-zone security config and keys, and (b) CDN token auth being left OFF afterwards — NOT by fragile code. This doc is the recovery checklist.

**Revisit if:** the Bunny library/pull zone is ever recreated (re-apply the config above), or if stricter enforcement is wanted (shorten the MAT TTL below 4h so a lapsed subscriber's in-flight token expires sooner).

---

## 2026-07-20 — Videos decoupled from sessions (event-level videos)

**Chosen:** Videos belong to the **event**, not to a session. `session_videos` → `event_videos` (`event_id` FK, `title_en`/`title_pt`, optional `video_date`, event-wide `position`). `video_progress` re-keyed to `(user_id, video_id)`. `session_subtitles` → `video_subtitles` keyed by `video_id` only; `subtitle_jobs` likewise. Admin uploads/imports attach to the event; the app renders an event-level video grid.

**Alternatives:** (a) keep session coupling and only fix labels — rejected, the model still misrepresents reality (one recording often spans several sessions; progress shared between a session's videos; offline limited to one file/session). (b) optional nullable `session_id` — rejected as YAGNI; nothing consumed the link except title derivation.

**Why:** User decision: the team produces recordings per morning/day, not per session; forcing per-session attachment produced wrong labels and awkward progress semantics with no compensating benefit. The AWS Batch subtitle container only uses `SESSION_ID`/`SESSION_NUMBER` for logs and a temporary S3 key (webhook re-homes by job row), so the pipeline decouples without an image rebuild — we now pass the video id and the union of the event's track numbers (`TRACK_NUMBERS`), which is more correct for multi-session videos since the transcript PDF is already event-level.

**Trade-offs:** Admins now name videos (migration backfills titles from the old session: time-period label + Part N). Old mobile binaries stop seeing videos (graceful — `sessions[].videos` disappears, tab hides) until an app update. Offline videos re-download once (local file re-keyed `video-{id}.mp4`); local resume positions reset, server-side positions migrated to each session's first video.

**Revisit if:** a real feature needs a video↔session link (e.g. jump from a session's transcript to the matching video timestamp) — add a join table then, not a FK on videos.

---

## 2026-10-20 — App membership = benefactor associates giving a regular donation

**Chosen:** User decision (André, for Associação Padmakara): people who join in the app become *associados beneméritos* (Estatutos, art. 3.º, 1, b), no voting rights) and give a regular donation with a minimum amount. Access to recordings rests on the statutes' right of associates to receive the Association's publications "nas condições definidas pela Direção", to be settled in writing by a Board deliberation. Every user-facing payment text says "donation"/"donativo": the Easypay item and bank descriptor, the hosted checkout page, the app's payment and manage screens, the emails and the terms.

**Alternatives:** (a) a sale of access with VAT. Rejected by the association: it doesn't want to charge VAT. (b) A full membership fee (*quota de associado*). Rejected because full associates get voting rights and must be invited to general meetings. (c) Two definitions in the terms: a purchase towards the consumer and a donation towards the tax office. Rejected on our advice, because the terms would contradict the receipts.

**Why:** It is one consistent description for the member, the terms and the receipts, which the association issues monthly from Easypay data in its AT-certified software, outside this system. It also matches how the association already takes regular donations through Easypay.

**Trade-offs:** The tax treatment of a donation that comes with a benefit is the association's call and its accountant's. It was flagged to them as a question and is not settled here. The terms carry `[[article]]`/`[[date]]` placeholders until the Board deliberation exists.

**Revisit if:** the accountant advises otherwise, or the Board deliberation sets different conditions.

---

## 2026-10-22 — Generated migrations from a single re-baselined snapshot

**Chosen:** New migrations are generated with `bun run db:generate`, diffing against `meta/0041_snapshot.json`. That snapshot is drizzle-kit's own serialization of the schema, checked against a throwaway PostgreSQL 16 built from all 42 migrations with `db:migrate`. The missing snapshots (0003, 0005–0040) are not rebuilt: drizzle-kit reads only the last snapshot file by name as its diff base, and only validates the others (format, no two snapshots with the same `prevId`). `db:generate` wraps drizzle-kit to keep the journal's `when` values increasing, because hand-written entries 0005–0041 are dated in the future (up to 2027-06-02) and drizzle-orm's migrator silently skips an entry whose `when` is not above the last applied one.

**Alternatives:** (a) Keep hand-writing migrations. Rejected: that is how the schema and database drifted apart. (b) Rebuild every missing snapshot. Rejected: drizzle-kit never reads them, so it is a lot of work with no effect. (c) Use the introspected database (`drizzle-kit pull`) as the baseline. Rejected: pull records index `opclass`, column order in unique constraints and array defaults (`'{""}'` for `'{}'::text[]`) differently from the serializer. The first generated migration would then drop and recreate 12 indexes and a unique constraint for nothing. (d) Rewrite the journal's future `when` values. Rejected: existing entries must not change, and `drizzle.__drizzle_migrations.created_at` mirrors them.

**Why:** The schema and the migration-built database match for every table, column, type, nullability, default, index and constraint definition. The only exceptions are listed below. So a schema-based snapshot describes the database correctly, apart from the constraint names below.

**Trade-offs:** Known drift between the database built from the migrations and the schema remains. None of it is fixed by a migration yet:
- Constraint names: hand-written SQL left PostgreSQL default names, while the snapshot uses drizzle-kit names. Changing one of these constraints through `db:generate` will fail on `DROP CONSTRAINT` until it is renamed. Proposed fix, to apply as its own migration once prod's names have been checked:
  ```sql
  ALTER TABLE "event_bookmarks" RENAME CONSTRAINT "event_bookmarks_user_id_fkey" TO "event_bookmarks_user_id_users_id_fk";
  ALTER TABLE "event_bookmarks" RENAME CONSTRAINT "event_bookmarks_event_id_fkey" TO "event_bookmarks_event_id_retreats_id_fk";
  ALTER TABLE "track_bookmarks" RENAME CONSTRAINT "track_bookmarks_user_id_fkey" TO "track_bookmarks_user_id_users_id_fk";
  ALTER TABLE "track_bookmarks" RENAME CONSTRAINT "track_bookmarks_track_id_fkey" TO "track_bookmarks_track_id_tracks_id_fk";
  ALTER TABLE "read_along_jobs" RENAME CONSTRAINT "read_along_jobs_event_id_fkey" TO "read_along_jobs_event_id_retreats_id_fk";
  ALTER TABLE "user_sync_versions" RENAME CONSTRAINT "user_sync_versions_user_id_fkey" TO "user_sync_versions_user_id_users_id_fk";
  ALTER TABLE "user_sync_versions" RENAME CONSTRAINT "user_sync_versions_pkey" TO "user_sync_versions_user_id_pk";
  ALTER TABLE "subtitle_jobs" RENAME CONSTRAINT "subtitle_jobs_session_video_id_fkey" TO "subtitle_jobs_video_id_event_videos_id_fk";
  ALTER TABLE "video_progress" RENAME CONSTRAINT "video_progress_user_id_fkey" TO "video_progress_user_id_users_id_fk";
  ALTER TABLE "video_progress" RENAME CONSTRAINT "video_progress_video_id_fkey" TO "video_progress_video_id_event_videos_id_fk";
  ALTER TABLE "video_subtitles" RENAME CONSTRAINT "session_subtitles_session_video_id_fkey" TO "video_subtitles_video_id_event_videos_id_fk";
  ALTER TABLE "payment_transactions" RENAME CONSTRAINT "payment_transactions_user_id_fkey" TO "payment_transactions_user_id_users_id_fk";
  ALTER TABLE "payment_transactions" RENAME CONSTRAINT "payment_transactions_dedupe_key_key" TO "payment_transactions_dedupe_key_unique";
  ALTER TABLE "event_videos" RENAME CONSTRAINT "event_videos_event_id_fkey" TO "event_videos_event_id_retreats_id_fk";
  ALTER TABLE "publications" RENAME CONSTRAINT "publications_audience_id_fkey" TO "publications_audience_id_audiences_id_fk";
  ALTER TABLE "retreat_organizers" RENAME CONSTRAINT "retreat_organizers_retreat_id_fkey" TO "retreat_organizers_retreat_id_retreats_id_fk";
  ALTER TABLE "retreat_organizers" RENAME CONSTRAINT "retreat_organizers_organizer_id_fkey" TO "retreat_organizers_organizer_id_organizers_id_fk";
  ALTER TABLE "retreat_organizers" RENAME CONSTRAINT "retreat_organizers_pkey" TO "retreat_organizers_retreat_id_organizer_id_pk";
  ALTER TABLE "organizers" RENAME CONSTRAINT "organizers_name_key" TO "organizers_name_unique";
  ALTER TABLE "organizers" RENAME CONSTRAINT "organizers_abbreviation_key" TO "organizers_abbreviation_unique";
  ```
  Verified on the throwaway database: after these renames, every constraint name matches the schema except the two cosmetic primary keys below.
- `users.stripe_customer_id` (with unique constraint `users_stripe_customer_id_unique`) exists in the database, from 0003, but not in the schema. Nothing in `src/` references it. Dropping it needs a migration and a check that prod holds no data in it.
- Enum types `file_action`, `file_category`, `log_level`, `migration_status` (from 0004) outlived the tables 0032 dropped. Harmless; drop them in a cleanup migration.
- Serial sequences `session_videos_id_seq` and `session_subtitles_id_seq` kept their pre-rename names (the schema would create `event_videos_id_seq` / `video_subtitles_id_seq`), as did the primary keys `session_videos_pkey` and `session_subtitles_pkey`. drizzle-kit does not track either, so this is cosmetic.
- Prod's actual names were not checked. If prod ever received a `db:push`, its names may already follow drizzle-kit, so check them before applying the rename.

**Revisit if:** `db:generate` plans changes nobody made, or prompts about renames. Re-baseline the latest snapshot the same way.

---

---

## 2026-10-22 — Schema drift cleanup migration (0042)

**Chosen:** Migration `0042_schema_drift_cleanup.sql` renames 22 constraints that kept PostgreSQL default names (`*_fkey`, `*_key`, `*_pkey`) to the Drizzle names the schema uses (`*_fk`, `*_unique`, `*_pk`), drops `users.stripe_customer_id` with its unique constraint (from 0003, absent from the schema, unused in `src/`), and drops the enum types `file_action`, `file_category`, `log_level`, `migration_status` left behind by 0004/0032. Each rename is a `DO` block guarded by "old name exists and new name does not", so it is idempotent and safe on a database where some renames already happened.

**Alternatives:** (a) Leave the names alone. Rejected: a later `db:generate` change to one of these constraints fails on `DROP CONSTRAINT`. (b) Also rename the serial sequences `session_videos_id_seq` / `session_subtitles_id_seq`. Rejected for now: not a constraint, purely cosmetic, and out of scope.

**Why:** Verified on a throwaway PostgreSQL 16: after `db:migrate` through 0042, constraint names and definitions are identical to a database built straight from the Drizzle schema; the unique-constraint, column and enum differences are gone; re-running 0042 changes nothing; a database with some renames reverted still converges.

**Trade-offs:** Dropping `stripe_customer_id` is irreversible. Production must be checked first: its constraint names may differ if a `db:push` ever ran there (the guard makes that safe, those renames are simply skipped), and the column must hold no data worth keeping. The two sequence names still differ from the schema.

**Revisit if:** the prod check shows `stripe_customer_id` is populated.
