# Multiple Videos Per Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-video-per-session limit with a `session_videos` join table so a session (a day of teaching) can hold an ordered list of Bunny Stream recordings, and add a script that ingests Google-Drive video files straight into Bunny without a local download.

**Architecture:** Video moves from three scalar columns on `sessions` (`bunny_video_id`, `video_duration_seconds`, `video_poster_url`) into a one-to-many `session_videos` table, mirroring the existing `sessions → tracks` shape. The public API returns a `videos[]` array per session; playback, the HLS proxy, the Bunny "ready" webhook, subtitles and admin CRUD all key off a `session_videos` row id / `bunny_video_id` instead of the session. The frontend Video tab becomes a grid of *recordings* (one card per `session_video`) instead of one card per session — audio and transcript tabs are untouched. A Bunny "fetch from URL" call lets the ingestion script pull Drive files server-side.

**Tech Stack:** Bun + Hono + Drizzle ORM + PostgreSQL + Zod v4 + Vitest (backend); React Native / Expo (frontend); Bunny Stream API; Google Drive API v3.

## Global Constraints

- **Migrations are hand-written SQL only.** Never `db:push`/`db:generate`. Create `src/db/migrations/0026_session_videos.sql` with `IF EXISTS`/`IF NOT EXISTS` guards, append a matching entry to `src/db/migrations/meta/_journal.json`, apply with `bun db:migrate`. (padmakara-api/CLAUDE.md)
- **Production content is already wiped** (see MEMORY `prod-wipe-refill`) — the backfill step is a safe no-op there, but write it anyway so the migration is correct on any populated DB.
- **Zod v4**, import `import { z } from "zod"`. `.safeParse()`/`.parse()`.
- **Run tests from the api dir via** `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run <pattern>'` (zoxide hijacks `cd`).
- **Typecheck** with `bun run typecheck`. Pre-existing errors in `src/routes/admin/publications.ts` and `src/routes/media.ts` (Uint8Array/BlobPart) are unrelated — ignore them; do not introduce new ones.
- **The word "subscription"/"subscrição" must never appear in mobile app UI** (unrelated here, but standing rule).
- **Commit granularity:** one coherent commit per task (Conventional Commits, `feat(...)`/`refactor(...)`), ending with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer.

---

## File Structure

**Backend — new**
- `src/db/schema/session-videos.ts` — the `session_videos` table + relations.
- `src/db/migrations/0026_session_videos.sql` — create table, backfill, drop old columns.
- `src/scripts/import-drive-videos.ts` — Drive folder → Bunny fetch → `session_videos` rows.
- `tests/services/session-videos.test.ts` — helper/service unit tests.

**Backend — modified**
- `src/db/schema/sessions.ts` — drop the 3 video columns; add `videos: many(sessionVideos)` relation.
- `src/db/schema/index.ts` — export the new schema.
- `src/services/bunny.ts` — add `fetchVideo(sourceUrl, title)`.
- `src/services/video-access.ts` *(new, extracted)* or `src/routes/media.ts` — playback keyed by `sessionVideoId`.
- `src/routes/media.ts` — `/video/session/:id` → `/video/:sessionVideoId`; HLS proxy path by `sessionVideoId`.
- `src/routes/webhooks.ts` — Bunny "ready" matches `session_videos.bunny_video_id`; caption handler resolves the session's primary video.
- `src/routes/admin/sessions.ts` — remove inline video field handling; ref-counted Bunny cleanup moves to the new videos CRUD.
- `src/routes/admin/session-videos.ts` *(new)* — CRUD for a session's videos (list/add/reorder/delete).
- `src/services/subtitles.ts`, `src/services/subtitle-translate.ts` — operate on the session's primary `session_video`.
- `src/lib/schemas.ts` — session response schema: replace 3 scalar fields with `videos[]`.

**Frontend — modified**
- `types/index.ts` — `Session.videos: SessionVideo[]`; new `SessionVideo` type; drop scalar video fields.
- `services/retreatService.ts` — map `videos[]`; `fetchSessionVideo` by `sessionVideoId`.
- `components/VideoGrid.tsx` — one card per video (session part), not per session.
- `components/VideoPlayer.tsx` — play a chosen `SessionVideo`.
- `app/(tabs)/(groups)/retreat/[id].tsx` — build the video list from `session.videos`, wire `watchSessionVideo(video)`.

---

## Scoping decisions (read before starting)

1. **Subtitles stay per-session, generated from the session's *primary* video** (`position = 0`). `submitSubtitleJob(sessionId)` keeps its signature but resolves the first `session_video`; captions are added to that video's `bunnyVideoId`. Per-video subtitles are explicitly out of scope — leave a `// TODO(multi-video-subtitles)` note. Rationale: the legacy recordings we're ingesting have no subtitles yet, and `session_subtitles` is keyed by `(sessionId, language)`.
2. **API contract is changed, not versioned.** Prod content is wiped and the app is ours, so the session shape swaps the 3 scalar fields for `videos[]` outright. No back-compat shim.
3. **Playback route re-keys from `sessionId` to `sessionVideoId`.** The MAT (media access token) carries `sessionVideoId` + `bunnyVideoId`; access control resolves `session_video → session → event` and runs the existing audience check.

---

## Task 1: `session_videos` schema + migration

**Files:**
- Create: `src/db/schema/session-videos.ts`
- Modify: `src/db/schema/sessions.ts`, `src/db/schema/index.ts`
- Create: `src/db/migrations/0026_session_videos.sql`
- Modify: `src/db/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `sessionVideos` Drizzle table with columns `id`, `sessionId`, `bunnyVideoId`, `position`, `title`, `durationSeconds`, `posterUrl`, `createdAt`, `updatedAt`; relation `sessions.videos = many(sessionVideos)` and `sessionVideos.session = one(sessions)`.

- [ ] **Step 1: Write `src/db/schema/session-videos.ts`**

```ts
import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.ts";

export const sessionVideos = pgTable(
  "session_videos",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // Bunny Stream video GUID. One recording file = one row.
    bunnyVideoId: text("bunny_video_id").notNull(),
    // Playback order within the session (0-based).
    position: integer("position").notNull().default(0),
    // Optional human label, e.g. "Part 1". Null → derive "Part N" from position.
    title: text("title"),
    durationSeconds: integer("duration_seconds"),
    posterUrl: text("poster_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("session_videos_session_id_idx").on(t.sessionId),
    // Webhook + playback look videos up by their Bunny GUID.
    index("session_videos_bunny_video_id_idx").on(t.bunnyVideoId),
  ],
);

export const sessionVideosRelations = relations(sessionVideos, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionVideos.sessionId],
    references: [sessions.id],
  }),
}));
```

- [ ] **Step 2: Edit `src/db/schema/sessions.ts`** — remove the three video columns (`bunnyVideoId`, `videoDurationSeconds`, `videoPosterUrl`) and their comment block; add the relation. Import at top: `import { sessionVideos } from "./session-videos.ts";`. In `sessionsRelations` add `videos: many(sessionVideos),` alongside `tracks: many(tracks)`.

- [ ] **Step 3: Export from `src/db/schema/index.ts`** — add `export * from "./session-videos.ts";`.

- [ ] **Step 4: Write the migration `src/db/migrations/0026_session_videos.sql`**

```sql
CREATE TABLE IF NOT EXISTS session_videos (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bunny_video_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  duration_seconds INTEGER,
  poster_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_videos_session_id_idx ON session_videos(session_id);
CREATE INDEX IF NOT EXISTS session_videos_bunny_video_id_idx ON session_videos(bunny_video_id);

-- Backfill any existing per-session video into the new table (no-op on a wiped DB).
INSERT INTO session_videos (session_id, bunny_video_id, position, duration_seconds, poster_url)
SELECT id, bunny_video_id, 0, video_duration_seconds, video_poster_url
FROM sessions
WHERE bunny_video_id IS NOT NULL;

ALTER TABLE sessions DROP COLUMN IF EXISTS bunny_video_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS video_duration_seconds;
ALTER TABLE sessions DROP COLUMN IF EXISTS video_poster_url;
```

- [ ] **Step 5: Append the journal entry** to `src/db/migrations/meta/_journal.json` — copy the last entry's shape, `idx` +1, `tag: "0026_session_videos"`, a fresh `when` epoch-ms (reuse the previous entry's value +1 to stay deterministic; the value is not load-bearing).

- [ ] **Step 6: Apply + typecheck**

Run: `sh -c 'cd .../padmakara-api && bun db:migrate && bun run typecheck 2>&1 | grep -v "publications.ts\|media.ts"'`
Expected: migration applies; typecheck surfaces the now-broken `session.bunnyVideoId` references in `media.ts`, `webhooks.ts`, `admin/sessions.ts`, `subtitles.ts`, `subtitle-translate.ts`, `lib/schemas.ts` (fixed in later tasks). This confirms the column drop took effect.

- [ ] **Step 7: Commit** `feat(db): add session_videos table for multiple videos per session` (schema + migration + journal only; leave the broken references for their own tasks or stage together with Task 2 if the tree must typecheck — see Task 2 note).

> **Note on ordering:** the tree will not fully typecheck until Tasks 2–5 land. Either commit Task 1 knowing typecheck is red, or run Tasks 1–5 as one working session and commit each once its file compiles in isolation. Recommended: implement 1→5 back-to-back, committing per task, and only run the full typecheck gate after Task 5.

---

## Task 2: Session API shape — `videos[]`

**Files:**
- Modify: `src/lib/schemas.ts:166-168`
- Modify: `src/routes/admin/sessions.ts` (read projection + create/update no longer take scalar video fields)
- Verify: the event/retreat read route already uses `db.query...with:{ sessions:{ with:{ tracks, ... } } }` — add `videos: true`.

**Interfaces:**
- Produces: session JSON carries `videos: Array<{ id: number; bunnyVideoId: string; position: number; title: string | null; durationSeconds: number | null; posterUrl: string | null }>` (ordered by `position`). The three scalar fields are gone.

- [ ] **Step 1: Edit `src/lib/schemas.ts`** — replace lines 166-168 (`bunnyVideoId` / `videoDurationSeconds` / `videoPosterUrl`) with:

```ts
  videos: z
    .array(
      z.object({
        id: z.number().int(),
        bunnyVideoId: z.string(),
        position: z.number().int(),
        title: z.string().nullable(),
        durationSeconds: z.number().int().min(0).nullable(),
        posterUrl: z.string().nullable(),
      }),
    )
    .default([]),
```

- [ ] **Step 2: Find the event-detail read** (`src/routes/events.ts` or wherever `db.query.events.findFirst/findMany` loads sessions with tracks) and add `videos: { orderBy: (v, { asc }) => [asc(v.position)] }` to each session's `with`. Grep: `grep -rn "sessions: {" src/routes` → add `videos:` next to `tracks:`.

- [ ] **Step 3: Edit `src/routes/admin/sessions.ts`** — remove `bunnyVideoId` from the read projection object (lines ~21-26 don't include it, but the create/update schema may). Delete the detach/ref-count block (lines ~96-119) and the DELETE ref-count block (lines ~141+) — that logic moves to Task 6 (session-videos CRUD). The session update no longer touches Bunny.

- [ ] **Step 4: Grep for any remaining `updateSessionSchema`/`createSessionSchema` video fields** and remove them.

- [ ] **Step 5: Commit** `refactor(api): expose session.videos[] instead of scalar video fields`.

---

## Task 3: Media playback per `session_video`

**Files:**
- Modify: `src/services/media-access.ts` (MAT payload gains `sessionVideoId`)
- Modify: `src/routes/media.ts:134-175` (route), `:195-250` (HLS proxy), `:340-370` (mp4 download)

**Interfaces:**
- Consumes: `sessionVideos` table; `buildPlaybackUrls(bunnyVideoId)` (unchanged).
- Produces: `GET /api/media/video/:sessionVideoId` → `{ proxyHls, iframe, hls, thumbnail, durationSeconds, expiresAt }`. HLS proxy at `GET /api/media/video/hls/:sessionVideoId/master.m3u8`. MAT payload includes `svid` (sessionVideoId) alongside `sid` and `gid`.

- [ ] **Step 1: Add a resolver** near `getEventForSession` in `media.ts`:

```ts
import { sessionVideos } from "../db/schema/session-videos.ts";

async function getVideoForPlayback(sessionVideoId: number) {
  const video = await db.query.sessionVideos.findFirst({
    where: eq(sessionVideos.id, sessionVideoId),
    with: { session: { with: { event: true } } },
  });
  if (!video) return null;
  return { video, session: video.session, event: video.session?.event ?? null };
}
```

- [ ] **Step 2: Rewrite `mediaRoutes.get("/video/session/:sessionId", ...)`** as `mediaRoutes.get("/video/:sessionVideoId", ...)`: resolve via `getVideoForPlayback`, run the same `checkEventAccess` on `result.event`, `buildPlaybackUrls(result.video.bunnyVideoId)`, `issueMat({ userId, sessionId: result.session.id, sessionVideoId, bunnyVideoId: result.video.bunnyVideoId })`, proxy base becomes `/api/media/video/hls/:sessionVideoId`, and the JSON reads `thumbnail: result.video.posterUrl ?? urls.thumbnail`, `durationSeconds: result.video.durationSeconds ?? null`.

- [ ] **Step 3: Update `src/services/media-access.ts`** — add `sessionVideoId: number` to `issueMat` args and to the signed payload (`svid`), and to the verify/decoded shape. The HLS-proxy verify at `media.ts:195-200` checks `decoded.svid !== routeSessionVideoId` instead of `sid`.

- [ ] **Step 4: Update the HLS proxy routes** (`/video/hls/:sessionVideoId/master.m3u8` and the sub-playlist route) to take `:sessionVideoId`, verify the MAT's `svid`, and sign Bunny paths using the MAT's `gid` (unchanged mechanism).

- [ ] **Step 5: Update the mp4 download route** (`media.ts:340-370`) to resolve by `sessionVideoId` and use `result.video.bunnyVideoId`.

- [ ] **Step 6: Typecheck** the file compiles. Commit `refactor(media): key video playback on session_video id`.

---

## Task 4: Bunny "ready" webhook + caption handler

**Files:**
- Modify: `src/routes/webhooks.ts:158-171` (video ready), `:265-271` (caption add)

**Interfaces:**
- Consumes: `sessionVideos`.
- Produces: on Bunny "video ready", `session_videos.duration_seconds` is set on the row whose `bunny_video_id = videoGuid`.

- [ ] **Step 1: Edit the "video ready" branch** (`webhooks.ts:~160-167`): replace the `sessions` update with

```ts
const result = await db
  .update(sessionVideos)
  .set({ durationSeconds: duration, updatedAt: new Date() })
  .where(eq(sessionVideos.bunnyVideoId, videoGuid))
  .returning({ id: sessionVideos.id });
```

Import `sessionVideos`. Update the log line to `session_video ${result[0]?.id}`.

- [ ] **Step 2: Edit the caption-received branch** (`webhooks.ts:~265-271`): resolve the session's primary video and add the caption to it:

```ts
const video = await db.query.sessionVideos.findFirst({
  where: eq(sessionVideos.sessionId, sessionId),
  orderBy: (v, { asc }) => [asc(v.position)],
});
if (video?.bunnyVideoId) {
  await addCaption(video.bunnyVideoId, language, label ?? language, vtt);
}
```

- [ ] **Step 3: Typecheck; commit** `refactor(webhooks): match Bunny events to session_videos`.

---

## Task 5: Subtitles operate on the primary `session_video`

**Files:**
- Modify: `src/services/subtitles.ts:34-64`, `src/services/subtitle-translate.ts:214-256`

**Interfaces:**
- Consumes: `sessionVideos`.
- Produces: `submitSubtitleJob(sessionId)` unchanged signature; internally uses the first `session_video`.

- [ ] **Step 1: In `subtitles.ts`**, after loading `session`, load its primary video and guard on that instead of `session.bunnyVideoId`:

```ts
const video = await db.query.sessionVideos.findFirst({
  where: eq(sessionVideos.sessionId, sessionId),
  orderBy: (v, { asc }) => [asc(v.position)],
});
if (!video) throw new Error("Session has no video");
// ...later:
const { url: videoAudioUrl } = buildMp4DownloadUrl(video.bunnyVideoId, "240p");
```

Add `// TODO(multi-video-subtitles): generate per session_video, not just the first.`

- [ ] **Step 2: In `subtitle-translate.ts`**, replace the `session.bunnyVideoId` guard/use (lines ~255-256) with the same primary-video lookup + `addCaption(video.bunnyVideoId, ...)`.

- [ ] **Step 3: Full typecheck gate** — `bun run typecheck` clean except the two pre-existing publications/media errors. Run backend tests: `vitest run`. Commit `refactor(subtitles): resolve primary session_video`.

---

## Task 6: Admin CRUD for session videos + Bunny cleanup

**Files:**
- Create: `src/routes/admin/session-videos.ts`
- Modify: `src/routes/admin/index.ts` (mount the routes)
- Test: `tests/routes/admin/session-videos.test.ts`

**Interfaces:**
- Produces REST under `/api/admin/session-videos`:
  - `GET /?sessionId=` → list ordered by position.
  - `POST /` `{ sessionId, bunnyVideoId, position?, title? }` → create.
  - `PATCH /:id` `{ position?, title? }` → update.
  - `DELETE /:id` → delete + ref-counted Bunny cleanup (delete the Bunny video only if no other `session_videos` row references the same `bunnyVideoId`).

- [ ] **Step 1: Write the failing test** `tests/routes/admin/session-videos.test.ts` — mock `db` and `deleteVideo` (`../../src/services/bunny.ts`); assert DELETE calls `deleteVideo` when no other row references the GUID, and skips it when one does. Follow the mock pattern in `tests/routes/admin/import.analyze.test.ts` (chainable `db` mock + `createAccessToken`).

- [ ] **Step 2: Implement `src/routes/admin/session-videos.ts`** — Hono routes with Zod bodies; the DELETE handler ports the ref-count logic removed in Task 2, but against `sessionVideos` (`and(eq(sessionVideos.bunnyVideoId, guid), ne(sessionVideos.id, id))`). Bump the events version after mutations (`bumpVersion("events")`).

- [ ] **Step 3: Mount** in `src/routes/admin/index.ts`: `adminRoutes.route("/session-videos", sessionVideoRoutes);`.

- [ ] **Step 4: Run tests; commit** `feat(admin): CRUD for session videos with ref-counted cleanup`.

---

## Task 7: Bunny fetch-from-URL service

**Files:**
- Modify: `src/services/bunny.ts` (add `fetchVideo`)
- Test: `tests/services/bunny-fetch.test.ts`

**Interfaces:**
- Produces: `fetchVideo(sourceUrl: string, title: string): Promise<{ guid: string }>` — POSTs to `https://video.bunnycdn.com/library/{libraryId}/videos/fetch` with `AccessKey`, body `{ url: sourceUrl, title }`, returns the created video's `guid`.

- [ ] **Step 1: Write the failing test** — mock global `fetch`; assert `fetchVideo("https://x/y.mpg", "T")` POSTs to the `/videos/fetch` URL with the `AccessKey` header and `{ url, title }` body, and returns `{ guid }` from the response.

- [ ] **Step 2: Implement** (mirror `createVideo`):

```ts
export async function fetchVideo(sourceUrl: string, title: string): Promise<{ guid: string }> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos/fetch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      AccessKey: config.bunny.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url: sourceUrl, title }),
  });
  if (!response.ok) {
    throw new Error(`Bunny fetch ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { guid?: string; id?: string };
  const guid = data.guid ?? data.id;
  if (!guid) throw new Error(`Bunny fetch returned no guid: ${JSON.stringify(data)}`);
  return { guid };
}
```

> Note: Bunny's `/videos/fetch` returns `{ success, message, statusCode }` and creates the video asynchronously; the created video's guid is not always in the fetch response body. If the response lacks a guid, the script (Task 10) falls back to listing recent library videos by title to recover it — see Task 10 Step 4.

- [ ] **Step 3: Run test; commit** `feat(bunny): add fetchVideo (pull from URL)`.

---

## Task 8: Frontend types + service

**Files:**
- Modify: `padmakara-app/types/index.ts:102-114`
- Modify: `padmakara-app/services/retreatService.ts:167-169`, `:800-835`

**Interfaces:**
- Produces: `SessionVideo = { id: number; bunnyVideoId: string; position: number; title: string | null; durationSeconds: number | null; posterUrl: string | null }`; `Session.videos: SessionVideo[]`. `retreatService.fetchSessionVideo(sessionVideoId: number)` (was per-session).

- [ ] **Step 1: Edit `types/index.ts`** — remove `bunnyVideoId`/`videoDurationSeconds`/`videoPosterUrl` from `Session`; add `videos: SessionVideo[]` and export the `SessionVideo` interface.

- [ ] **Step 2: Edit `retreatService.ts` session mapping (~167-169)** — replace the three scalar mappings with:

```ts
videos: (backend.videos ?? []).map((v: any) => ({
  id: v.id,
  bunnyVideoId: v.bunnyVideoId ?? v.bunny_video_id,
  position: v.position ?? 0,
  title: v.title ?? null,
  durationSeconds: v.durationSeconds ?? v.duration_seconds ?? null,
  posterUrl: v.posterUrl ?? v.poster_url ?? null,
})),
```

- [ ] **Step 3: Rename/retarget the video-playback fetch (~800-835)** from `/media/video/session/:id` to `/media/video/:sessionVideoId`; the function now takes a `sessionVideoId`.

- [ ] **Step 4: Typecheck** `cd padmakara-app && npx tsc --noEmit` (expect only call-site errors in VideoGrid/VideoPlayer/retreat, fixed in Task 9). Commit `refactor(app): Session.videos[] + fetch video by id`.

---

## Task 9: Frontend Video tab — one card per recording

**Files:**
- Modify: `padmakara-app/components/VideoGrid.tsx`
- Modify: `padmakara-app/components/VideoPlayer.tsx`
- Modify: `padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx` (`:238-241`, `:662-668`, `:1274-1303`, `:1441-1447`, `:840-849`, `:1824-1831`)

**Interfaces:**
- Consumes: `Session.videos`, `SessionVideo`, `retreatService.fetchSessionVideo`.
- Produces: Video tab renders one `VideoSessionCard` per `SessionVideo` (labelled with the session title + "Part N" when the session has >1 video). `watchSessionVideo(video: SessionVideo, session: Session)` opens the player for that recording.

- [ ] **Step 1: `VideoGrid.tsx`** — change props to accept a flat list of `{ session, video }` pairs (or `videos: SessionVideo[]` + a `sessionForVideo` lookup). Build the display title as `renderTitle(session)` plus, when `session.videos.length > 1`, `— ${video.title ?? "Part " + (video.position + 1)}`. Duration/poster come from `video`, not `session`.

- [ ] **Step 2: In `retreat/[id].tsx`** replace `hasVideo`/`videoSessions` logic:
  - `hasVideo = retreat.sessions?.some((s) => (s.videos?.length ?? 0) > 0)`.
  - Build `videoItems = sessions.flatMap((s) => s.videos.map((v) => ({ session: s, video: v })))` sorted by session order then `v.position`.
  - Default-tab effect (`:662-668`) uses the new `hasVideo`.
  - `<VideoGrid items={videoItems} onPlay={({ session, video }) => watchSessionVideo(video, session)} .../>`.

- [ ] **Step 3: `watchSessionVideo` + player state** — change state from `videoSession: Session | null` to `activeVideo: { session: Session; video: SessionVideo } | null`; `watchSessionVideo(video, session)` sets it.

- [ ] **Step 4: `VideoPlayer.tsx`** — props take `video: SessionVideo | null` (+ the parent `session` for titling); it calls `fetchSessionVideo(video.id)` for the proxy HLS URL. Update the render at `retreat/[id].tsx:1824` accordingly.

- [ ] **Step 5: Manual smoke** (`npm run web`), plus `npx tsc --noEmit` clean. Commit `feat(app): video tab lists all recordings per session`.

---

## Task 10: Google Drive → Bunny ingestion script

**Files:**
- Create: `src/scripts/import-drive-videos.ts`
- Docs: short usage block at the top of the file.

**Interfaces:**
- CLI: `bun src/scripts/import-drive-videos.ts --event <eventId> --folder <driveFolderId> [--dry-run]`.
- Env: `GDRIVE_API_KEY` (Drive API key; folder shared "anyone with link — viewer"), Bunny creds from `config.bunny`, `DATABASE_URL`.

**Behavior:**
1. List the Drive folder via `GET https://www.googleapis.com/drive/v3/files?q='{folderId}'+in+parents+and+trimmed&key={KEY}&fields=files(id,name,size)&pageSize=1000` → filter `.mpg`/`.mp4`/`.mov`.
2. For each file, parse the leading `YYYYMMDDHHMMSS` timestamp from the name → date + time; group/sort so each date's files get ascending `position` (0,1,2…).
3. Match the file's date to a `sessions` row of the target event (`sessionDate = YYYY-MM-DD`). Skip + warn if no session matches that date.
4. Build a direct-download URL Bunny can pull: `https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&key={KEY}` (works for large, link-shared files; avoids the `uc?export=download` virus-scan gate).
5. `fetchVideo(driveMediaUrl, title)` → get `guid` (fall back to listing recent library videos by title if the fetch body has none).
6. Insert a `session_videos` row `{ sessionId, bunnyVideoId: guid, position, title: "Part N" | null }`.
7. `--dry-run` prints the plan (file → session date → position) without calling Bunny or writing rows.

- [ ] **Step 1: Write the failing test** `tests/scripts/import-drive-videos.test.ts` for the pure helper `parseDriveVideoName(name)` → `{ date: "2009-06-21", time: "16:13:50" } | null` and `assignPositions(files)` → files grouped by date with ascending positions. (Keep network/db out of the unit test.)

- [ ] **Step 2: Implement** `parseDriveVideoName` (regex `^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})`) and `assignPositions` (sort by date+time, reset position per date), then the network/db `main()` guarded by `import.meta.main`.

- [ ] **Step 3: Run test; commit** `feat(scripts): import Drive videos into Bunny + session_videos`.

- [ ] **Step 4: Manual run against the KTGR event** — `--dry-run` first, confirm the 4 files map to 2009-06-21 (positions 0,1), 2009-06-22 (0), 2009-06-23 (0); then live run. Report the created guids.

---

## Self-Review

- **Spec coverage:** multi-video model (T1), API contract (T2), playback (T3), webhook (T4), subtitles (T5), admin CRUD (T6), Bunny fetch (T7), frontend types/service (T8), frontend UI (T9), Drive→Bunny script (T10). ✅
- **Type consistency:** `sessionVideos` columns (`bunnyVideoId`, `position`, `durationSeconds`, `posterUrl`) are referenced identically in T3/T4/T5/T6; the API/`SessionVideo` shape matches between `lib/schemas.ts` (T2) and `types/index.ts` (T8); `fetchSessionVideo(sessionVideoId)` used the same way in T8/T9; MAT `svid` introduced in T3 and only consumed there.
- **Open risk to verify during T3:** the MAT/HLS-proxy re-key from `sessionId` to `sessionVideoId` is the trickiest change — confirm the sub-playlist rewrite still preserves the `mat` query param and that `decoded.svid` is checked (not `sid`).
- **Out of scope (documented):** per-video subtitles (T5 note); API versioning/back-compat (prod wiped).
