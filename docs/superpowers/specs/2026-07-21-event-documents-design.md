# Event Documents — Design Spec

**Date:** 2026-07-21
**Author:** Jeremy + Claude
**Status:** Approved (design), pending implementation plan
**Repos touched:** `padmakara-api` (backend + admin), `padmakara-app` (frontend)

---

## 1. Goal

Replace the single per-event "transcript" concept with a general **Documents** feature:

1. An event can hold many documents — transcript, images, PDFs, Word, Excel, PowerPoint — uploaded easily from the admin.
2. The mobile/web app shows these in a unified **Documents** tab, with the transcript always pinned first and visually distinct.
3. The admin event **list** shows presence icons (video / audio / documents) per event — icon only if present, no counts.
4. The admin event list **search** field gets a magnifying-glass icon.

All three ship together (single spec, single plan).

---

## 2. Background — current state

- **`transcripts` table** (`src/db/schema/transcripts.ts`): event-level PDFs (column `retreat_id` → `events.id`), fields `language`, `s3Key`, `pageCount`, `status`, `originalFilename`, `fileSizeBytes`. Served to the app embedded in the event detail payload (`events.ts` `eventWithSessions` `with: { transcripts: true }`) and as watermarked bytes via `GET /api/media/transcript/:id` (per-user name+email stamped on every page with `pdf-lib`). The app opens it in a full-page viewer (`app/(tabs)/(groups)/transcript/[id].tsx`) reached from a **pseudo-tab** in `retreat/[id].tsx`. Transcript drives the read-along + subtitle pipelines.
- **`event_files` table** (`src/db/schema/event-files.ts`): a **dormant** generic-file table — `eventId`, optional `sessionId`, `originalFilename`, `s3Key`, `fileType` (image | subtitle | document | design | other), `extension`, `fileSizeBytes`, `language`. Only ever populated by migration scripts (`src/scripts/*`). No admin UI, no API endpoint, no app display.
- **Two known gaps:**
  - The admin transcript drop-zone (`TranscriptDropZone` in `admin/src/resources/events.tsx`) uploads the PDF to S3 (`POST /api/admin/upload/presign-transcript` → deterministic key `events/{eventCode}/transcripts/{filename}`) but **never inserts a `transcripts` row**. So an admin-dropped transcript never reaches the app. Rows only exist from data migration.
  - The admin event-list query (`GET /api/admin/events`, `src/routes/admin/events.ts`) loads none of `sessions`/`tracks`/`videos`/`transcripts`/`eventFiles` and returns no counts, so list rows cannot currently know what content an event has.

---

## 3. Design decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Data model | **Keep `transcripts` as-is; revive `event_files` for generic documents.** App merges both into one Documents list, transcript pinned first. No single-table migration. |
| D2 | Non-inline formats (Word/Excel/PPT) | **Download / open externally.** PDF + images render inline; everything else is a download / share action. No server-side conversion. |
| D3 | Watermark | **Per-document `sensitive` flag.** A sensitive PDF is watermarked per-user on serve (reusing the transcript watermark logic); a non-sensitive file is served as-is. |
| D4 | Scope | **All three volets in one delivery.** |
| D5 | Transcript watermark | **Always on** (unchanged). Transcript is sensitive by nature; the `sensitive` flag governs only generic documents. |
| D6 | Transcript persistence bug | **Fixed as part of this work** — the admin transcript drop-zone will persist a `transcripts` row. |
| D7 | Offline download of generic documents | **Out of scope for v1.** Transcripts keep their native cache; other docs open online / download on demand. |

**Rejected alternative:** a unified `event_documents` table absorbing transcripts. Rejected because it would force migrating transcript rows and re-wiring read-along, subtitles, watermarking, the app viewer, and native caching — high risk, and it contradicts D1 (transcript must stay distinct).

---

## 4. Data model changes

Extend `event_files` (`src/db/schema/event-files.ts`) with three columns:

| Column | Type | Notes |
|--------|------|-------|
| `sensitive` | `boolean NOT NULL DEFAULT false` | If true and the file is a PDF, watermark per-user on serve (D3). |
| `title` | `text` (nullable) | Optional human label shown in the app; falls back to a cleaned `originalFilename`. |
| `sortOrder` | `integer NOT NULL DEFAULT 0` | Order within the Documents tab; admin can reorder. |

**No changes to `transcripts`.**

**Migration** — hand-written, idempotent, per the migrations-only workflow (`padmakara-api/CLAUDE.md`):
- `src/db/migrations/NNNN_event_files_documents.sql`:
  - `CREATE TABLE IF NOT EXISTS event_files (...)` mirroring the full current schema (the table may have been created only via script in some environments — belt-and-suspenders).
  - `ALTER TABLE event_files ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;` (and `title`, `sortOrder`).
- Append the matching entry to `src/db/migrations/meta/_journal.json`.
- Apply locally with `bun db:migrate`. Prod: `psql -f` + insert sha256 into `drizzle.__drizzle_migrations`, restart service. Also apply against `padmakara_test` separately (test DB is not touched by `db:migrate`).

**Visibility rule** (used everywhere the app is served documents): an `event_files` row is a *user-visible document* iff `fileType IN ('document','image','other')`. `subtitle` and `design` rows stay admin/internal-only (subtitles attach to media, not to the Documents tab).

---

## 5. Backend — API

### 5.1 Admin: presign upload for generic files

`src/routes/admin/upload.ts` — add `POST /api/admin/upload/presign-file`:
- Body (Zod): `{ eventCode, filename, fileType }`.
- Builds key `events/{eventCode}/{fileType}/{filename}` (matches the existing `add-event-files.ts` convention).
- Returns `{ s3Key, uploadUrl }` (presigned PUT), mirroring `presign-transcript`.
- Add `buildEventFileS3Key(eventCode, fileType, filename)` to `src/services/s3.ts`.

### 5.2 Admin: `event-files` resource (new)

New `src/routes/admin/event-files.ts`, mounted in `src/routes/admin/index.ts` as `admin.route("/event-files", eventFileRoutes)` (follows the `videos`/`tracks` pattern):
- `GET /` — list (react-admin: `_start/_end/_sort/_order`, `Content-Range`), filterable by `eventId`.
- `POST /` — create a row (called after the S3 PUT completes). Body validated with a new `createEventFileSchema` in `src/lib/schemas.ts`: `{ eventId, originalFilename, s3Key, fileType, extension, fileSizeBytes?, language?, title?, sensitive?, sortOrder? }`.
- `PUT /:id` — update editable fields (`title`, `sensitive`, `sortOrder`, `language`, `fileType`).
- `DELETE /:id` — delete the row **and** the S3 object (best-effort S3 delete; do not fail the request if the object is already gone).
- Register `event-files` in the admin data provider resource whitelist and in `admin/src/App.tsx` as a hidden/inline resource (no standalone menu entry needed — it is edited inside the Event form, like transcripts/videos).

### 5.3 Admin: `transcripts` resource (fix persistence — D6)

New `src/routes/admin/transcripts.ts`, mounted as `admin.route("/transcripts", transcriptRoutes)`:
- `POST /` — insert a `transcripts` row after the transcript PDF is PUT to S3 (`{ eventId, language, s3Key, originalFilename, fileSizeBytes?, pageCount?, status? }`). Default `status: 'published'` so it appears in the app immediately.
- `PUT /:id`, `DELETE /:id` (delete removes the S3 object best-effort).
- The admin transcript drop-zone handlers (`handleTranscriptFilesDropped` / `handleEditTranscriptFilesDropped` in `admin/src/resources/events.tsx`) call `dataProvider.create('transcripts', …)` after upload, replacing the current local-state-only behaviour.

### 5.4 Admin: event-list content flags (Volet 2)

`GET /api/admin/events` (`src/routes/admin/events.ts`) — add three booleans per row via cheap `EXISTS` subqueries (no full relation loading):
- `hasVideo` — `EXISTS (SELECT 1 FROM event_videos WHERE event_id = events.id)`.
- `hasAudio` — `EXISTS (SELECT 1 FROM tracks JOIN sessions ON tracks.session_id = sessions.id WHERE sessions.retreat_id = events.id)`.
- `hasDocuments` — `EXISTS (transcripts of this event) OR EXISTS (event_files of this event WHERE file_type IN ('document','image','other'))`.

Prefer Drizzle `sql`/`exists()` correlated subqueries in the `findMany`/select so the list stays a single query.

### 5.5 App: event detail payload

`src/routes/events.ts` — extend the shared `eventWithSessions` `with` clause to also load `eventFiles` (filtered to the visible `fileType` set). Keep `transcripts` as-is. The response now carries both `transcripts[]` and `eventFiles[]`; the app merges them (§7). Access control is unchanged (documents follow event access, exactly like transcripts already do).

### 5.6 App: serve generic file bytes

New `GET /api/media/file/:id` in `src/routes/media.ts` (authed, mirrors `GET /api/media/transcript/:id`):
- Resolve the `event_files` row → its `eventId` → `checkEventAccess(user, event)` (403 otherwise).
- If `sensitive` and extension is PDF → fetch from S3 and watermark per-user with the existing `pdf-lib` routine (extract that routine into a shared helper so both transcript and file endpoints use it).
- Else → stream inline, or `?download=true` → `Content-Disposition: attachment`. Images stream with their `image/*` content-type.
- Content-type derived from extension.

---

## 6. Admin UI

### 6.1 Documents section in the Event form (Volet 1)

In `admin/src/resources/events.tsx`, add a **Documents** section to both `EventCreate` and `EventEdit`, beside the existing Transcript section:
- A `DocumentsDropZone` component (new, modelled on `TranscriptDropZone` + `admin/src/utils/uploadManager.ts`):
  - Accepts images, PDF, `.doc/.docx`, `.xls/.xlsx`, `.ppt/.pptx`.
  - Per file: presign (`presign-file`) → `PUT` to S3 with progress → `dataProvider.create('event-files', …)`, deriving `fileType` from the extension (image → `image`, office/pdf → `document`, else `other`) and `extension`.
  - Requires the event to be saved first (needs `eventCode`), same guard as transcripts.
- A list of existing documents (from `event-files` filtered by `eventId`) with: title edit, `sensitive` toggle, drag-or-arrow reorder (`sortOrder`), delete. Reuse/extend `EventFilesPreview` where practical.

### 6.2 Transcript section (D5/D6)

Keep the existing Transcript drop-zone as a **separate** section (it feeds read-along + subtitles). Only behavioural change: it now persists a `transcripts` row (§5.3). Transcript watermark stays always-on.

### 6.3 Content icons column (Volet 2)

Add a column to `EventList`'s `<Datagrid>` (`admin/src/resources/events.tsx`) rendering three MUI icons — `Videocam`, `Audiotrack`, `Description` — each shown only when the corresponding `hasVideo`/`hasAudio`/`hasDocuments` flag is true (absent otherwise; no count). Tooltip per icon. Localize tooltips (admin i18n en/pt).

### 6.4 Search icon (Volet 3)

Replace `<TextInput key="q" source="q" alwaysOn>` (events.tsx:273) with react-admin's `<SearchInput source="q" alwaysOn>`, which ships the magnifying-glass adornment + clear button. Update the import.

---

## 7. Frontend app — Documents tab

### 7.1 Model + service

- `padmakara-app/types/index.ts`: add an `EventDocument` shape and an `eventFiles?: EventFile[]` field on the event type (keep `transcripts`).
- `padmakara-app/services/retreatService.ts`: build a merged, ordered `documents` list from `transcripts` + visible `eventFiles`:
  - Transcript(s) first, flagged `featured: true`, `viewer: 'pdf'`.
  - Then `eventFiles` ordered by `sortOrder`, each with a `viewer` derived from extension: `pdf` | `image` | `download`.
  - Add `getFileUrl(fileId, …)` mirroring `getTranscriptPdfUrl` (web: URL with `?token=`; native: fetch/stream, cache for PDFs optional).

### 7.2 UI

- In `app/(tabs)/(groups)/retreat/[id].tsx`, replace the transcript pseudo-tab with a real **Documents** tab:
  - Transcript rendered as a distinct "featured" card at the top; other documents listed below.
  - Tap behaviour by `viewer`:
    - `pdf` → existing `PDFViewer` (transcript keeps the watermarked transcript endpoint + native cache; other PDFs use `/api/media/file/:id`).
    - `image` → an image viewer (new lightweight full-screen image component, or reuse an existing modal).
    - `download` → download / open externally via `Linking` / `expo-sharing` (guard `Platform.OS`; web opens in a new tab).
  - The content-type count that decides whether the tab bar shows now includes "documents" (present iff ≥1 document). Update `contentTypeCount` / `effectiveTab` logic accordingly.
- Keep the standalone transcript viewer route working for PDFs.

### 7.3 Localization

Add a `documents.*` section to `padmakara-app/locales/en.json` and `pt.json` (tab label, "Transcript", "Download", "Open", empty state, error states, per-type labels). All new user-facing strings use `t('documents.x') || 'Fallback'`. No hardcoded English. (Reminder: never use the word "subscription" anywhere — unrelated here but a standing rule.)

---

## 8. Access control & security

- Generic file bytes (`/api/media/file/:id`) enforce the **same** event access check as transcripts (`checkEventAccess`). Documents are never more permissive than the event that owns them.
- Watermarking: `sensitive` PDFs get the per-user name+email stamp; the transcript stays always-watermarked. Extract the current transcript watermark code from `media.ts` into a shared helper to avoid divergence.
- S3 objects for documents live under `events/{eventCode}/{fileType}/…`; delete-row also deletes the S3 object (best-effort).

---

## 9. Out of scope (v1)

- Server-side conversion of Office files to PDF (D2).
- Offline download/caching of generic documents (D7) — transcripts keep their existing native cache.
- Per-language document titles (single optional `title` only; `language` tag already exists).
- Session-scoped documents in the UI (`event_files.sessionId` stays event-level in the UI; column retained for future use).
- Making transcript watermarking optional (D5 — stays always-on).

---

## 10. Testing plan

Backend (Vitest, mocked-db pattern per `padmakara-api/CLAUDE.md`):
- `presign-file`: valid → returns key+url; bad body → 400.
- `event-files` resource: create/list/update/delete happy paths + validation + not-found; delete also calls S3 delete.
- `transcripts` resource: create persists a row (regression guard for D6); delete removes S3 object.
- `GET /api/admin/events`: rows include correct `hasVideo/hasAudio/hasDocuments` for events with/without each content type.
- `GET /api/media/file/:id`: 403 without access; watermarks when `sensitive` PDF; streams non-sensitive as-is; `?download=true` sets attachment; 404 for missing.
- Event detail payload includes visible `eventFiles` and excludes `subtitle`/`design`.

Frontend:
- `retreatService` merge helper: transcript first + `featured`; files ordered by `sortOrder`; correct `viewer` per extension.
- (Lightweight) Documents tab renders featured transcript + list; tap routes to the right handler.

Run backend tests via the documented `sh -c` + vitest command; ensure the migration is applied to `padmakara_test`.

---

## 11. File-by-file change list

**padmakara-api (backend):**
- `src/db/schema/event-files.ts` — add `sensitive`, `title`, `sortOrder`.
- `src/db/migrations/NNNN_event_files_documents.sql` + `meta/_journal.json` — migration.
- `src/lib/schemas.ts` — `presignFileSchema`, `createEventFileSchema`, `updateEventFileSchema`, `createTranscriptSchema`.
- `src/services/s3.ts` — `buildEventFileS3Key`; ensure S3 delete helper exists.
- `src/routes/admin/upload.ts` — `POST /presign-file`.
- `src/routes/admin/event-files.ts` — new resource (list/create/update/delete).
- `src/routes/admin/transcripts.ts` — new resource (create/update/delete).
- `src/routes/admin/index.ts` — mount both new routes.
- `src/routes/admin/events.ts` — `hasVideo/hasAudio/hasDocuments` in list query.
- `src/routes/events.ts` — load visible `eventFiles` in `eventWithSessions`.
- `src/routes/media.ts` — `GET /file/:id`; extract shared watermark helper.

**padmakara-api (admin UI):**
- `admin/src/App.tsx` — register `event-files` (+ `transcripts`) resources.
- `admin/src/dataProvider.ts` — allow the new resources (any per-resource mapping).
- `admin/src/utils/uploadManager.ts` — `presignFile` / `uploadFile`.
- `admin/src/resources/events.tsx` — `DocumentsDropZone` + list in Create/Edit; transcript handlers persist rows; content-icons column in `EventList`; `SearchInput` swap.
- `admin/src/components/EventFilesPreview.tsx` — extend to manage generic documents (title/sensitive/reorder/delete) if reused.
- Admin i18n (`admin/src/i18n/*`) — icon tooltips + Documents labels (en/pt).

**padmakara-app (frontend):**
- `types/index.ts` — `EventDocument` / `eventFiles` field.
- `services/retreatService.ts` — merge helper + `getFileUrl`.
- `services/apiConfig.ts` — file media endpoint constant.
- `app/(tabs)/(groups)/retreat/[id].tsx` — Documents tab (featured transcript + list) + tab-visibility logic.
- New image-viewer component (or reuse) + download/open-external handler.
- `locales/en.json`, `locales/pt.json` — `documents.*`.

---

## 12. Deployment

Per project workflow (memory: `padmakara-main-deploy-workflow`): commit directly to `main` and run `deploy/deploy.sh padmakara@admin.padmakara.pt` after backend/admin changes. Migration must be applied to prod DB (and `padmakara_test`) as described in §4. App changes ship via the normal Expo flow.
