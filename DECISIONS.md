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

---

## 2026-10-22 — Resumable bulk audio upload: browser queue + server reconciliation

**Chosen:** Keep the two-phase bulk upload (track rows first, audio second). Make phase 2 resumable with a per-event queue in `localStorage` (`padmakara.pendingAudioUpload.<eventId>`) that records, for each track, the dropped file's name and size and whether it reached the server. After every upload, however it ended, the admin calls `GET /api/admin/events/:id/missing-audio` and treats the server's keyless tracks as the source of truth; the queue only supplies the file-to-track mapping. Transient failures (network, 408/429/5xx) are retried with exponential backoff, and each file is presigned right before its own upload.

**Alternatives:** (a) An atomic upload (audio first, rows after). Rejected: it breaks rename-before-upload and the AI name analysis. (b) IndexedDB, to keep `File` handles across reloads. Rejected: handles from a drop or an `<input>` cannot be re-read after a reload without the File System Access API (Chromium only, permission prompt), so a re-drop is needed anyway, and the queue is a few KB of JSON. (c) A server-side queue table. Rejected: it needs a migration and still cannot hold the files; the server already knows which tracks are keyless.

**Why:** The rename mapping (dropped name to edited `originalFilename`) only exists in the browser that ran the upload, and without it a renamed track cannot be matched to its file. Everything else is recoverable from the database.

**Trade-offs:** The queue is per browser: resuming from another machine falls back to matching by the track's `originalFilename` and recorded size, which misses tracks renamed before upload (those still have the per-track "Upload audio" button). Presigning per file costs one extra request per file.

**Revisit if:** uploads move to a resumable protocol (S3 multipart, tus) or admins routinely resume on a different machine.

---

## 2026-10-22 — Keep hero originals so a crop can be redone

**Chosen:** User decision (Jérémy): reopening a hero must show the original with the zoom, crop and black-and-white chosen last time. The admin still crops in the browser and uploads the cropped region, which the server turns into the desktop/mobile variants as before. With it, the admin uploads the original file once (`original`), the crop rectangle in pixels of the original (`crop`) and the B&W choice (`grayscale`). The server stores the original under `{teachers|groups}/heroes/originals/` and the three new columns (`hero_original_s3_key`, `hero_crop`, `hero_grayscale`, migration 0043). `GET /:id/hero/source` serves the original when there is one, and the editor restores the crop through react-easy-crop's `initialCroppedAreaPixels`.

**Alternatives:** (a) Upload only the original and crop on the server with sharp. Rejected for now: it moves the B&W and crop code to the server and changes the pipeline the apps depend on, for no visible gain. (b) Keep cropping destructively. Rejected: a crop could only ever be tightened, and B&W never undone (André's report).

**Why:** The crop rectangle is the one thing react-easy-crop needs to restore frame and zoom exactly; storing it next to the untouched original makes every edit reversible.

**Trade-offs:** Originals take storage (full-size photos). Heroes saved before this change have lost their original: the first re-edit uploads the current cropped hero as the new original. Replacing or removing a hero by key (PUT) deletes its original.

**Revisit if:** heroes need server-side variants of other aspect ratios, at which point cropping on the server from the original is the better design.

---

## 2026-10-22 — Publication access: retreat groups and an access list

**Chosen:** User decision (agreed with the client). A publication keeps one audience, and the audience says what to fill in. Shown in the app: public (everyone), subscribers (as before), retreat group members (members of at least one retreat group ticked on the publication, same rule as events: active subscription plus membership), event participants (members who attended an event of a ticked group). Hidden in the app unless access is given: available on request only, received initiation, and the new `restricted` audience (migration 0044): nobody, except the users on the publication's access list (no subscription needed), and admins. The list, detail and PDF endpoints apply this server-side; a refused hidden publication answers 404 on the PDF endpoint, so it is neither listed, nor openable, nor confirmed to exist. Two join tables hold the data: `publication_retreat_groups` and `publication_access_users`. For events, `restricted` is treated like available on request only.

**Alternatives:** (a) Keep linked events as the access source. Rejected: the client thinks in groups and people, and an event link says nothing about who is meant. (b) One access table with a kind column. Rejected: two plain join tables keep the foreign keys and the cascade rules trivial. (c) Drop `event_publications`. Rejected: events still list their related publications through it, and prod data depends on it.

**Why:** Groups and an explicit list are what the admins actually decide, and a hidden audience that falls open on an empty list would be a privacy leak, so an empty list means nobody.

**Trade-offs:** Legacy fallback: a publication of an event-based audience that has no ticked groups (group, participants) or an empty access list (initiation, on request) keeps deciding by its linked events until an admin classifies it; once groups or people are added, the linked events stop counting (their rows stay). `restricted` has no legacy. Admins see hidden publications in the app. The admin shows legacy linked events read-only with a note.

**Revisit if:** the legacy publications have all been reclassified (then the linked-events branch and the read-only display can go), or the app needs a "request access" teaser for hidden publications.

---

## 2026-10-24 — Video bookmarks move server-side

**Chosen:** User decision (Jérémy): bookmarks placed inside a video are stored on the server in a new `video_bookmarks` table (migration 0045: user, video, position in seconds, optional note, created_at), not only in the app's AsyncStorage. Endpoints under `/api/content/video-bookmarks` (list mine, create, update note, delete). Creating one reuses the video-progress access check (event visible to the caller plus audience rule). Several bookmarks per video are allowed, so there is no unique on (user, video). The create endpoint accepts an optional `createdAt` (never in the future) so the app can upload its old local bookmarks with their original dates.

**Alternatives:** (a) Keep them local and merge them into the Bookmarks tab on the device. Rejected: they would still be lost when changing phone, and the web app could not show them. (b) Reuse the older `bookmarks` table (track + position). Rejected: it is keyed by track, videos are keyed by `event_videos`; overloading it with a nullable video id would mix two schemas (same reasoning as `video_progress`).

**Why:** Bookmarks are personal content the user expects to find on any device, next to event and track bookmarks.

**Trade-offs:** Bookmarks of a video that is deleted are deleted with it (cascade). A re-burn that changes the intro length shifts positions in the video, and unlike resume positions they are not offset by `burned_intro_ms`.

**Revisit if:** videos get re-burned often enough that bookmark positions drift (then offset them by the intro delta like progress).

---

## 2026-10-24 — Per-frame hero framing (overrides next to the focal point)

**Chosen:** User decision (Jérémy, after the designer's request): a hero keeps its single focal dot as the default for every app layout, and each layout (`home`, `home-short`, `page`, `desk-home`, `desk-page`, the HERO_FRAMES keys) may carry its own override `{ focalX, focalY, zoom }` (focal in % of the stored hero, zoom 1-3, 1 = plain cover). Stored in a nullable jsonb `hero_frame_overrides` on `teachers` and `retreat_groups` (migration 0046), the only tables with their own hero. Validated with Zod (known keys only), returned wherever the focal fields are. The admin previews are directly adjustable (drag to pan, slider to zoom, Reset). The app picks its layout's entry, else the focal point; with zoom it scales the cover size around the frame centre and clamps so the frame stays covered. A legacy `hero_scale` is ignored on a layout that has an override.

**Alternatives:** (a) One focal point only, as before. Rejected: one point cannot frame a 3:2 card, a 390x380 page and a 776x380 desktop banner well at once. (b) A crop per layout (several stored images). Rejected: multiplies storage and uploads, and the designer only needs a different centre and zoom of the same picture. (c) Keep overrides when the crop changes. Rejected: they are positions in the stored crop, so after a re-crop they would frame other pixels.

**Why:** Pan and zoom of the same stored variants is enough for the designer's cases and needs no new image processing. Zoom is limited to 3x because the stored variants (2400 / 1200 px wide) get soft beyond that; the admin caption warns when a zoomed frame drops below the 2400 / 1200 px thresholds (crop width divided by zoom).

**Trade-offs:** Overrides are tied to the stored crop: a hero upload, a changed crop or a replaced image clears them (the dialog says so; the server clears them on any upload that does not resend them). The teacher and group pages show the 'page' frame on desktop too, as the 'desk-page' frame exists only for the event page. Sharpness of a zoomed frame is judged from the crop width, not from the frame's device pixels.

**Revisit if:** designers want more than centre and zoom per layout, or a layout is added (add its key to HERO_FRAME_KEYS, HERO_FRAMES and the app).

---

## 2026-10-25 — A single, movable, published-only event highlight

**Chosen:** User decision (Jérémy): exactly one event holds the home-page highlight (`retreats.featured_at`). It can be moved to another event, never removed, and only a published event can hold it. The only way to set it is `POST /api/admin/events/:id/feature`, which in one transaction clears every other star and stamps the target (409 `EVENT_NOT_PUBLISHED` for a non-published target). `POST /` and `PUT /:id` ignore `featuredAt` in the body (the field stays optional in the Zod schema so the admin's full-record saves still parse). Unpublishing or deleting the featured event is refused with 409 `FEATURED_EVENT_LOCKED`. Migration 0049 keeps only the most recent star among published events (clearing all stars if none is published) and adds the partial unique index `retreats_single_featured_idx ON retreats ((true)) WHERE featured_at IS NOT NULL`, which guarantees at most one starred row at the database level. The index is defined only in SQL: drizzle-kit cannot express an expression index on `(true)`, so it is absent from the Drizzle schema and snapshot. Because the index is checked row by row, the route clears the other stars before setting the target.
**Alternatives:** (a) Keep any number of stars and show the most recent, as before. Rejected: the home page only ever shows one, so the other stars were invisible state that misled editors. (b) Allow removing the highlight (zero featured). Rejected: the home page would have no hero event. (c) Enforce only in application code. Rejected: concurrent requests could still leave two stars.
**Why:** Before this change the admin could star any number of events, in any status, and `GET /api/events/featured` returned the most recently starred visible one, so a star on a draft or on an older event had no effect that anyone could see.
**Trade-offs:** To unpublish or delete the highlighted event an editor must first highlight another published event. The app must always have at least one published event to hold the highlight.
**Revisit if:** the home page shows several featured events, or a "no highlight" state becomes valid.

---

## 2026-10-27 — Account deletion and payment records (PROVISIONAL)

**Status:** PROVISIONAL, pending the association's decision. Implemented so the app can pass Apple 5.1.1(v) and Google Play review; the retention rules below are our reading of the law, not a ruling.
**Chosen:** Deleting an account (in-app `DELETE /api/auth/user/delete`, or the emailed link from the public page `/account-deletion`) removes the user row and everything personal (devices, tokens, group memberships, progress, all bookmark kinds, video progress, download requests, publication access, approval requests and login links matching the email). `payment_transactions` rows are RETAINED: `user_id` is set to NULL and the `customer` block (name, email, phone, tax number) is stripped from `raw_payload` / `raw_subscription`. Amounts, dates, Easypay ids, actions and notes stay. A live Easypay subscription is stopped first (same PATCH `status=inactive` the webhook uses); if Easypay cannot be reached the deletion is refused with 502 so nothing keeps charging a deleted member. Admin and superadmin accounts cannot be deleted this way (409).
**Alternatives:** Hard-delete payment rows (rejected: Portuguese bookkeeping law keeps accounting documents about 10 years, and the ledger is also our webhook idempotency guard). Keep `user_id` and only blank the user (rejected: it would keep the person identifiable). Delete even when Easypay fails (rejected: orphaned recurring charges).
**Why:** Store rules require deletion of the account and associated data; tax law requires keeping the accounting trail. Detaching plus stripping the customer block satisfies both as far as we can tell without a lawyer.
**Trade-offs:** `customer.key` (`user-{id}`) is also removed, so a replayed webhook for a deleted member is recorded as "unresolved" and cannot be re-attributed. The tax number may be needed on invoices if the association's accountant issues them from this ledger; if so the stripping must be relaxed. A member who cancelled earlier is not re-cancelled at Easypay. Generated download ZIPs in object storage are not purged (they expire after 24 hours).
**Revisit if:** the association or its accountant decides on a different retention period or on which billing fields must stay; or Easypay offers a way to delete the customer record.

## 2026-10-28 — 6-digit sign-in code alongside the magic link

**Chosen:** The magic-link email also carries a 6-digit code, stored (as `code_hash`) on the same `magic_link_tokens` row as the link. `POST /api/auth/verify-code` accepts it from the device that requested it. The hash is HMAC-SHA256 keyed with the JWT secret, compared with `timingSafeEqual`. Each token allows 5 wrong guesses (`code_attempts`), the code is bound to the requesting device fingerprint, and every failure returns the same generic 401 ("Invalid or expired code"). Using the link or the code consumes the row, so the other stops working.
**Alternatives:** A separate code table; a plain sha256 of the code; a longer code; a global per-email lockout instead of per-token attempts; returning distinct errors for expired / locked / wrong.
**Why:** The link fails when it is opened on a different device than the app (mail read on a laptop, app on a phone), and the polling flow cannot help there. A code can be typed anywhere. Only 10^6 codes exist, so a plain hash would be reversed offline in microseconds by anyone reading the table; a keyed HMAC is useless without the server secret. Five attempts per token plus the existing IP/email rate limiters make online guessing negligible (5 in 10^6 per token). Binding to the fingerprint means an attacker with the code but not the device cannot use it. Sharing the row keeps the one-time guarantee trivial. One generic 401 avoids leaking which emails exist or which tokens are live.
**Trade-offs:** Rotating the JWT secret invalidates outstanding codes (they live one hour, so harmless). A code typed on a different device than the one that requested it does not work; the person must request a new link there. The code appears in the email body, so mailbox access equals access, as with the link.
**Revisit if:** codes are abused despite the limiters, or a flow needs to sign in on a device other than the requester.

---

## 2026-10-28 — Passkeys: RP ID, invitation timing, libraries

**Chosen:** Passkeys are bound to the relying-party ID `app.padmakara.pt` (origin `https://app.padmakara.pt`; `localhost` in development), configured through `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` and `WEBAUTHN_ANDROID_ORIGINS`. The server uses `@simplewebauthn/server` and the clients use `@simplewebauthn/browser` (web) and a native passkey module (app). Challenges live 5 minutes and are single use; login uses discoverable credentials with no `allowCredentials`; every login failure is the same 401. User decision (Jérémy): when to invite a person to create a passkey (after a first successful email sign-in, once per user per device, never after a passkey sign-in) is the product owner's call, not fixed by the API.
**Alternatives:** RP ID `padmakara.pt` (parent domain); RP ID `api.padmakara.pt`; hand-rolled WebAuthn verification; inviting at registration or on every sign-in.
**Why:** A passkey is tied to its RP ID forever and cannot be moved, so the choice must be stable. The web app and the associated-domain files (Apple app-site-association, Android assetlinks) live on `app.padmakara.pt`, which is the host the browser and both mobile platforms will vouch for. Using the parent domain would also let any other subdomain that is ever added ask for these keys; the API host is not where people sign in. A maintained library handles CBOR, attestation parsing and counter checks, which are easy to get subtly wrong by hand.
**Trade-offs:** If the web app ever moves to another host, existing passkeys stop working and people must sign in by email and register again. Native sign-in depends on the associated-domain files staying correct on `app.padmakara.pt`. Two client libraries to keep updated.
**Revisit if:** the web app moves off `app.padmakara.pt`, or the association wants one passkey to work across several subdomains.

---

## 2026-11-02 — Video burn scratch disk at 200 GiB

**Chosen:** User decision (Jérémy): the `padmakara-video-burn` Batch job definition (revision 4) gets 200 GiB of Fargate ephemeral storage, the maximum. The container also deletes the downloaded master once its MP4 remux exists, so a burn needs about twice the master size plus the slide segments.
**Alternatives:** 50 GiB (the original size, too small for a 16 GB master); 100 or 150 GiB (enough for today's masters, up to roughly 45 and 70 GB).
**Why:** A 16 GB master failed with "No space left on device" while the master, its remux and the merged output (about 49 GB) were all on a 50 GiB disk. Storage above the free 20 GB costs $0.000129 per GB-hour in eu-west-3 and is billed on the size reserved, so 200 GiB costs about 2.3 cents per job-hour against 1.7 cents for 150 GiB: the extra headroom for a full-day single-file recording is nearly free.
**Trade-offs:** Every burn pays for 200 GiB whether it uses it or not (about 0.6 cent per job-hour more than 150 GiB).
**Revisit if:** after a few dozen burned videos the largest master stays well under 70 GB, drop to 150 GiB; check master sizes in the bucket under `events/*/masters/` or the burn job logs.

---

## 2026-11-16 — Membership access follows Easypay captures, not webhook bodies

**Chosen:** The Easypay webhook body (`type`, `status`, `date`) is a hint only. Access is extended by `creditNewCaptures`: it reads `GET /subscription/{id}`, takes each `transactions[]` entry whose `values.paid` is positive and covers `values.requested`, and credits each one not yet counted by one interval, keyed on the capture's Easypay id (`payment_transactions.easypay_transaction_id`, unique). Each credit locks the member row and computes the new expiry from what it read. A refund or chargeback closes access only when `GET /refund/{id}` (status `success`) or `GET /chargeback/{id}` names a capture we credited; any other reversal is recorded as `reversal_review` for a human. A failed Easypay read (other than 404) or database write releases the dedupe claim and answers 503; a 404 on a capture notification is recorded `unverified` and answered 200. An hourly job reconciles every live Easypay member and, for two weeks, the subscriptions of 404'd capture notifications.
Captures credited before this change ("legacy" rows: `activated` / `extended` with no `easypay_transaction_id`) are recognised at run time, not by a backfill: a capture is counted when its id is listed in the `raw_subscription` of a legacy row of the same subscription, or when it is no newer than the newest legacy credit of that subscription.
**Alternatives:** (a) Keep trusting the body and add a shared secret: Easypay generic notifications offer only Basic Auth on the URL, which does not stop a replay of a real notification with a new `date`. (b) A backfill migration inserting one baseline row per stored capture id: explicit, but it misses any capture credited between the migration and the restart, and any capture Easypay had not yet listed when its notification was processed. (c) A per-subscription baseline column set at deploy: same deploy window, plus a second source of truth. (d) Read `GET /subscription/{id}/cycles` (has a status per cycle): not linked to capture ids in the documentation and never seen in production.
**Why:** `transactions[]` with an id, a date and `values.paid` is documented and present in every snapshot stored after a successful capture, so it is the one source we can both trust and key on. Legacy rows never change after deploy, so a run-time rule derived from them has no deploy window and needs no data migration. The time cutoff covers the case where a snapshot did not list its own capture; `src/scripts/membership-capture-dry-run.ts` measures how often that happened and lists any member whose date the stored history does not explain.
**Trade-offs:** A capture the old code missed before its last credit (for example a lost notification followed by a later successful one) is never credited automatically; the dry run flags it. A body that claims success while Easypay lists no new capture changes nothing (`no_new_capture`), so if Easypay ever notifies before listing a capture the member waits up to an hour for the reconcile job. Whether a refund's `capture.id` equals the subscription's `transactions[].id` is not documented; if not, refunds are left to a human. The "payment failed" email and page state still follow the body's `failed` status (no access changes on it). Reversals close all remaining access, as before.
**Revisit if:** the dry run shows `next` or `lag` above 0, Easypay documents a status per transaction or how subscription refunds and chargebacks are notified, a first real refund or chargeback arrives, or Direct Debit / MB WAY subscriptions show a different `transactions` shape than card.

---

## 2026-11-16 — subscription_create adopts only what Easypay reports as just created

**Chosen:** A `subscription_create` notification can swap the member's stored subscription id, or stop a subscription, only when `GET /subscription/{id}` reports that subscription created within the last 72 hours and its `method.status` is not `inactive`. Otherwise it is recorded as `create_not_adopted` and nothing changes. When the create is acted on and the stored subscription cannot be read to compare ages (anything but a 404), the webhook answers 503 instead of failing open. The capture path is unchanged: there a paid capture Easypay lists on the subscription vouches for it.
**Alternatives:** (a) Require `method.status === "active"`: the documented enum is active / inactive / waiting, but which value a freshly stored card shows is not confirmed from production data, so this could block every real card update. (b) Adopt only on a paid capture and ignore creates entirely: a card update while access runs would then leave the old card charging until the new subscription's first capture, a double charge at period end. (c) Keep trusting the body: anyone holding a member's subscription id could stop their live subscription.
**Why:** Easypay's subscription record has no top-level state we can rely on (the sandbox read in July 2026 had none; the docs show only an `ok` example), but it has `created_at` and `method.status`. A real create arrives within a minute of the card being stored, so recency is the evidence that this notification is about a subscription just created; 72 h covers Easypay's retries and our own 503s.
**Trade-offs:** A create delayed past 72 h is not acted on; that subscription is then adopted by its first paid capture (the capture path), and until then the old one may still charge. A forger who learns a member's subscription id within 72 h of its creation can only trigger what the real notification would do anyway.
**Revisit if:** production `raw_subscription` rows of `tokenized` / `method_updated` show the `method.status` of a fresh card (then require it), or Easypay documents a subscription-level status on GET.

---

## 2026-11-16 — Refunds and chargebacks of teaching purchases remove that purchase's access

**Chosen:** A refund (status `success`) or chargeback is read back from Easypay; when its `capture.payment_type` is `SINGLE` (or absent and no membership capture matches) and its `capture.payment_id` is the `easypay_payment_id` of a teaching order in status `paid`, for at least the order amount, the order becomes `refunded` and the `event_access_grants` row with `source = 'purchase'` and that `order_id` is deleted, in one transaction (ledger action `teaching_reversed`). A partial reversal, one on an order that is not paid, or one naming no order of ours is recorded as `reversal_review` and changes nothing. A replay finds the order already `refunded` and is recorded `ignored`.
**Alternatives:** (a) Leave every teaching reversal to a human (the previous behaviour, by accident): a chargeback kept access open indefinitely. (b) Pro-rata or partial-refund handling: no rule exists for what a partial refund of a recording buys. (c) Match on the refund's `capture.id` against the single payment's `captures[]`: needs one more Easypay read and the id equality is not documented, whereas `payment_id` is exactly what we stored.
**Why:** Same evidence rule as membership reversals: Easypay's own refund or chargeback record must name a payment we recorded as paid. Free claims and manual grants carry another `source` and no order, so they are never touched; a buyer who already had such a grant got no purchase grant, and keeps the one they have.
**Trade-offs:** A goodwill partial refund leaves access open until a human decides. The app sees a new order status `refunded`.
**Revisit if:** the Board wants partial refunds to remove access, or a refunded buyer should keep access (e.g. a refund given as a gift).

---

## 2026-11-17 — Membership refunds take back one interval; chargebacks end the membership

**Chosen:** User decision: a membership reversal, still verified as before (`GET /refund/{id}` with status `success`, or `GET /chargeback/{id}`, naming a capture we credited), is applied by kind.
- **Refund:** one interval (the frequency of the subscription as stored on the credit row) is taken off `subscription_expires_at`, but the date never goes before the refunded capture's own time and never moves later. `subscription_status` stays as it is unless the new date is already past, then `expired`; otherwise access follows the normal rule (paid-through date plus grace). The subscription at Easypay keeps running. Ledger action `refund_interval_removed`.
- **Chargeback:** the capture's subscription and the member's current one (they differ after a card update) are stopped at Easypay first (PATCH `inactive`; a 404 counts as already gone). Then, in one transaction under the member row lock: `subscription_status = 'expired'`, `subscription_expires_at = now`, `subscription_cancelled_at` set if empty. Ledger action `chargeback_closed`. A failed stop releases the dedupe claim and answers 503 before anything is written, so Easypay's retry starts clean.
- Both: the ledger note names the reversal, the capture, the subscription and the paid-through date before and after. A replay (another notification for the same refund or chargeback id) is recorded `ignored` and changes nothing; the check runs before the Easypay stop and again under the lock. A capture that later restores the access of a member with a `refund_interval_removed` on that same subscription sends no welcome email.

**Alternatives:** (a) Close all access on any reversal (the behaviour until now): a refund of one month cut off a yearly member's remaining paid time, and since the date and the Easypay subscription were left untouched, the next capture silently reactivated the member and welcomed them again. (b) Remove exactly the dated slot the refunded capture paid for: the ledger stores no slots, and a hole in the middle of a paid period means nothing for access. (c) Treat a chargeback like a refund: a bank dispute says the member did not agree to be charged; charging them again is the worst outcome. (d) Floor at "now" instead of the capture date: a refund could then never end access that is already running.
**Why:** A refund is Padmakara giving one payment back (wrong amount, double charge, goodwill); it should cost the member exactly what that payment bought. The capture-date floor follows from how crediting counts (`expiryAfterCapture` starts each interval at the later of the paid-through date and the capture time): access before the capture was paid by something else and is not this refund's to take. A chargeback is a dispute; the relationship ends, and the member can join again through a fresh checkout.
**Trade-offs:** A refund of an older capture removes one interval from the end, not the period that capture covered: paid time is counted, not mapped to dates. A member who paid on 1 January and 1 February and is refunded the January capture keeps access through 1 February — one month, which is what they paid for net. A partial refund still removes a whole interval (no prorating rule exists). If the member's source has since become admin or cash, the interval is still taken off that date (bounded by the capture-date floor). A refund that ends access leaves the Easypay subscription running, so its next scheduled capture restores access (by design, and without a welcome). A chargeback applies only once Easypay confirms the stop; until then Easypay keeps retrying and access stays open.
**Revisit if:** the Board wants partial refunds prorated, refunds that also stop the subscription, or a chargeback won by Padmakara to restore access automatically (today that is a manual admin change).

---

## 2026-11-17 — Publication status: existing texts published, new ones start as drafts

**Chosen:** Publications use the `status` column that has existed since migration 0010 (`text NOT NULL DEFAULT 'draft'`), with the event rule mirrored in `services/publication-status.ts`: `draft` is listed and opened by admins only; `forthcoming` is listed (list, event page) to the people its audience lets in, carrying `status`, but `GET /api/publications/:id/pdf` answers 403 `PUBLICATION_FORTHCOMING` to non-admins; `published` behaves as before. Any other value is neither listed nor opened, admins included. Migration 0075 sets every existing row to `published`; the column default stays `draft`, and the admin create form starts on Draft.
**Alternatives:** (a) Change the column default to `published`: keeps today's upload-and-it-is-live flow, but defeats the workflow André asked for. (b) 404 for a forthcoming PDF, as event content does: the app could not tell "not yet" from "gone". (c) Keep the status rule inside `openablePublications`: several route tests mock that module wholesale, and events keep status and audience separate too.
**Why:** Nothing ever wrote or read the column, so every live publication holds the default `draft`; turning the rule on without the data fix would have hidden the whole catalogue. Draft-first gives admins room to prepare a text before anyone sees it.
**Trade-offs:** A text uploaded and saved without touching the selector stays invisible in the app until set to Published. Until the app knows `status`, a forthcoming text shows as a normal entry whose tap fails silently (the app logs the 403 and shows nothing).
**Revisit if:** admins find draft-first gets in the way, or the app ships forthcoming support (then nothing to change here).

---

## 2026-11-17 — Publication authors stay a text[] column, picked as chips

**Chosen:** Keep `publications.authors text[]` (one element per author, no separator to escape). The admin edits it as one chip per author, suggested from the distinct names already used (`GET /api/admin/publications/authors`) plus the teachers; a typed name that differs from a suggestion only by case or diacritics takes the existing spelling.
**Alternatives:** (a) An `authors` table with a join: real identity per author, but a schema migration, a data split and app response changes for a list of a few dozen names. (b) Snap to the teachers table only: authors include figures (Buda Śākyamuni, Mañjuśrī) who are not teachers.
**Why:** The storage was never the problem: the edit page turned the array into a comma-joined text field that re-parsed on every keystroke and swallowed the separator.
**Trade-offs:** Variants already stored stay until an admin fixes them (the suggestions list shows both spellings). Two different people with one spelling are one name.
**Revisit if:** authors need their own page or biography in the app.

---

## 2026-11-18 — Per-file transcript metadata: status describes, `published` decides

**Chosen:** User decision: André (product owner) and Jérémy. Each transcript row carries `language` (en / pt / fr / tib, editable in the admin), `status` (`final` / `provisional` / `unrevised` / `draft`, default `final`), `is_excerpt` (boolean) and `published` (boolean). The status is descriptive only, shown to readers as a small tag; it never controls visibility, because a provisional, unrevised or draft file is sometimes shared on purpose (André). `published` alone decides whether non-admins see a file: unpublished rows are dropped from event payloads (`services/media-visibility.ts`) and from the events list count, announcements count only published rows, and `GET /api/media/transcript/:id` answers the same 404 as a hidden section. Migration 0076 keeps existing rows published and makes new uploads start unpublished, so an admin switches each new file on (Jérémy). Old `status` values (`published`, `draft`, written but never read) map to `final`. The publish switch replaces the old Wix "Request PDF label"; no cover, no bilingual PDFs, no import of the old Wix metadata for now (André). `page_count` is computed server-side on upload with pdfinfo; `scripts/backfill-transcript-page-counts.ts` fixes existing rows (dry run by default, `--apply` to write). Whisper subtitle gating and read-along keep using every row, published or not: a draft still guides transcription and alignment. Event payloads now list transcript columns explicitly, so `s3Key` no longer reaches clients.
**Alternatives:** (a) Derive visibility from status (final/provisional visible, draft/unrevised hidden): hiding a final file while it is corrected would force a fake status change, and André wants to share unrevised texts knowingly. (b) A fifth status value "excerpts": loses the "excerpts + provisional" combination the old data has. (c) A database CHECK on `language`: the legacy seed (`scripts/csv-parser.ts` `mapLanguage`) can write `unknown`, so the language is validated in Zod only. (d) New uploads published immediately (the previous behaviour): an unreviewed file would reach readers the moment it is dropped.
**Why:** Two independent decisions (what the document is, whether readers get it) need two fields; the event-level `transcripts_published` switch stays the section gate above them. Starting new uploads unpublished matches the publication draft-first workflow decided on 2026-11-17.
**Trade-offs:** An admin who uploads a transcript and forgets the switch leaves it invisible in the app (the admin shows an "Unpublished" chip and a hint after upload). Admins in the app see unpublished files with no marker, as they see drafts. The read-along of a track stays even when every transcript file of the event is unpublished.
**Revisit if:** André wants per-file read-only (no download) transcripts, covers, or the Wix metadata imported.

---

## 2026-11-18 — Storage keys stay server-side: explicit client columns for tracks, videos and files

**Chosen:** App-facing routes load tracks, event videos and event files with the column lists in `src/lib/client-columns.ts` (`TRACK_CLIENT_COLUMNS`, `VIDEO_CLIENT_COLUMNS`, `EVENT_FILE_CLIENT_COLUMNS`), so `s3Key` and `masterS3Key` are never selected. Videos go to clients without `slides` (the slide document, whose image lines carry `@builtin/...` and uploaded keys) and without the burn pipeline state: the slides are burnt into the video and the app never read them. `readAlongS3Key` is still loaded, only to derive `hasReadAlong`, and dropped before the response (`toClientTrack`, or the speaker enrichment in `routes/events.ts`). Group photos keep their keys for signing and lose them afterwards (`resolveClientGroupUrls`); the event photo already did (`resolveEventImageUrls`), now also on the session, track and last-played payloads. Admin routes keep full rows.
**Alternatives:** (a) Delete the keys from each payload after the query: one forgotten route leaks again, and every new column reaches clients by default. (b) A deep scrubber run over every response: hides the problem instead of not loading the data, and would also strip keys an admin response needs. (c) Keep sending a derived file extension: the app never read `s3Key` (no reference in padmakara-app's code or history), so nothing needs replacing.
**Why:** Storage is private and a key alone opens nothing, but keys reveal the bucket layout and file names, and `GET /api/events/public` served them to anonymous callers.
**Trade-offs:** A track, video or file column a client should see must be added to its list by hand. Bookmarks, track bookmarks and last-played tracks now carry `hasReadAlong` instead of the raw read-along key.
**Revisit if:** the app needs slide data (e.g. to render intros client-side): serve a resolved copy then, never the stored document.

---

## 2026-11-18 — Explicit client columns for events and sessions too

**Chosen:** App-facing routes load events with `EVENT_CLIENT_COLUMNS` and sessions with `SESSION_CLIENT_COLUMNS` (`src/lib/client-columns.ts`); the track list loses the AI review flags. Events keep the content the app shows (titles, themes, bibliography, dates, original language), the columns the server still reads on the way out (status, per-section publish switches, audience, membership flag, sale fields, photo columns that become `image`) and the timestamps. Left out: `notes` (Wix library notes imported by `seed-content.ts`, never shown in the app nor in the admin form), every `...Reviewed` flag, `eventCode`, `s3Prefix`, `wixId`, `librarySnapshot`, `creditLines`, `copyrightHolder`, `publishedNotifiedAt/Count` and the hero re-edit state. Client groups also lose `heroCrop`/`heroGrayscale`, and `GET /api/users/profile` drops `subscriptionNotes` and signs its group photos.
**Alternatives:** (a) Trim to exactly what `padmakara-app` reads today: bibliography, the publish switches and the sale fields are not read by the app, but they are public content or are needed server-side, so dropping them buys nothing and could break a client (web) that starts reading them. (b) Delete the internal columns after the query: same objection as for storage keys, a new column would leak by default.
**Why:** Unauthenticated `GET /api/events/public` served the imported library notes, the AI review state, the announcement counts and the storage prefix. The app (any version, per its git history) reads none of the removed fields: `eventCode` only appears in its e2e dataset.
**Trade-offs:** A new event or session column a client should see must be added to its list by hand.
**Revisit if:** the app needs the event code (e.g. for share links): send a slug made for it instead.
