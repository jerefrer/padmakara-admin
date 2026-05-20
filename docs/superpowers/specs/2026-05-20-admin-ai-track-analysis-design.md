# Admin AI Track Analysis — Design

**Date:** 2026-05-20
**Status:** Draft
**Repo:** `padmakara-api` (backend + admin UI)

## Goal

When an admin creates a new event by dropping a folder of audio files into the
React-admin "Create event" page, the system runs an intelligent analysis pass
(Claude Sonnet 4.6) before showing the preview. The pass:

- Infers event metadata (dates, group, place, teacher, titles) from the folder
  name following the agreed naming convention.
- Groups files into sessions and orders tracks.
- Fixes typos in track titles and adds missing accents on display titles
  (Portuguese in particular).
- Produces a corrected filename per track (ASCII, no accents, no typos) which
  becomes the actual S3 key on upload.
- Reports per-track corrections (field/before/after/reason) so the admin can
  review what changed.
- Surfaces free-text notes about inconsistencies (missing track numbers,
  orphan files, deviation from the folder-name convention).

The drop-to-preview transition becomes asynchronous (no main-thread freeze)
with a spinner that reports progress for large folders.

## Background

The current flow (`admin/src/resources/events.tsx::EventCreate`,
`admin/src/components/TrackDropZone.tsx`, `admin/src/components/SessionPreview.tsx`)
is already drop-first: clicking "Create event" shows only the dropzone, and on
drop a deterministic parser (`admin/src/lib/trackParser.ts::parseTrackFile` +
`inferSessions`) extracts metadata, infers sessions, and pre-fills the form.
The admin then reviews and saves.

Two problems with the current flow:

1. **Synchronous parsing freezes the browser** for any non-trivial folder.
   `parseTrackFile` runs regex on each file and `inferSessions` walks all
   tracks — all on the main thread, no spinner, no async boundary.
2. **Parsing is deterministic regex only.** It cannot fix typos, add missing
   accents (filenames are ASCII; display titles need diacritics), recognise
   that two filename spellings refer to the same teaching, or flag
   inconsistencies. Files are uploaded to S3 with their literal (possibly
   typo'd, possibly inconsistent) names via `buildTrackS3Key(eventCode,
   sessionNumber, filename)` (`src/services/s3.ts`).

A similar AI analysis exists in `src/services/import-inference.ts` for the
historical S3 import flow, but its prompt is tuned for that use case
(inferring metadata from accumulated S3 paths, no agreed convention) and is
not reused here — see "Why not share `import-inference.ts`" below.

## Non-Goals

- Refactoring `src/services/import-inference.ts`. It continues to serve the
  S3 import flow unchanged. A future cleanup may extract shared building
  blocks into `track-conventions.ts`, but that is not in scope here.
- Changing the upload mechanism (presign → S3 PUT → track update). Only the
  S3 key string changes from "literal filename" to "AI-corrected filename".
- Persisting the original (uncorrected) filename anywhere. Once the admin
  confirms the preview, the corrected filename is the authoritative one and
  the original is dropped. Traceability is provided by the in-session
  corrections panel, not by long-term storage.
- Re-running AI analysis on existing events. This feature only applies to
  new event creation through the drop flow. The existing flow for adding
  tracks to an already-created event (if any) stays as-is.
- Mobile/web app changes. This is purely a backend + admin UI feature.

## Architecture

### High-level flow

```
Click "Create event"
        │
        ▼
TrackDropZone (empty state, unchanged UI)
        │ drop
        ▼
1. Walk FS entry tree, collect { relativePath, sizeBytes } async
2. Show spinner overlay
3. POST /api/admin/import/analyze and read response body as a stream
   (fetch + ReadableStream + manual SSE-line parsing — native
   EventSource is GET-only, so we use fetch streaming with the same
   line protocol).
        │
        ▼
Backend pipeline (src/services/track-analysis.ts)
  ├─ Deterministic first pass (reuses parseTrackFile + inferSessions)
  ├─ Decide single-pass vs chunked based on file count
  ├─ Call Claude (1 or N chunks, parallel with concurrency=4)
  ├─ Validate each chunk's JSON against Zod schema
  ├─ Per-chunk fallback to deterministic if AI fails
  └─ Merge → emit `result` SSE event
        │
        ▼
EventCreate state populated:
  - form metadata (titles, dates, code, lookups)
  - sessions[] with tracks[] including corrections[]
  - notes[]
  - aiCoverage stats
        │
        ▼
SessionPreview renders:
  - Per-track ✨ badge if corrections.length > 0
  - Expandable diff panel per corrected track
  - "AI notes" section at the bottom
  - Fallback banner if any chunk degraded to deterministic
        │
        ▼ admin saves
Existing upload flow (uploadManager) — but presign uses
correctedFilename as the S3 key.
```

### New files

- `src/routes/admin/import/analyze.ts` — SSE endpoint
  `POST /api/admin/import/analyze`. Auth: admin/superadmin only.
- `src/services/track-analysis.ts` — orchestrates deterministic pass +
  Claude calls + chunking + merge.
- `src/services/track-conventions.ts` — single source of truth for the
  folder-name convention, filename convention, writing rules (accents,
  capitalisation), and shared Zod schemas. Pure data + schemas, no runtime
  logic. Imported by `track-analysis.ts` today; importable by
  `import-inference.ts` in a future cleanup.

### Modified files

- `admin/src/components/TrackDropZone.tsx` — replace synchronous
  `parseTrackFile`/`inferSessions` with an async pipeline that calls
  `/api/admin/import/analyze` via `EventSource`. Add spinner overlay with
  cancel button.
- `admin/src/components/SessionPreview.tsx` — per-track correction badge +
  expand-on-click diff panel, AI notes section, fallback banner.
- `admin/src/resources/events.tsx::EventCreate` — `handleFolderDropped`
  receives the enriched result instead of `(meta, tracks)`. Drop the now-dead
  `parsedTracks` state in favour of `sessions[]` only.
- `admin/src/lib/uploadManager.ts` — when calling `/api/admin/upload/presign`,
  use `correctedFilename` (per-track) instead of the File's original `name`.
  The `File` object is still uploaded as-is; only the S3 key changes.

### Backend: endpoint contract

`POST /api/admin/import/analyze`

Auth: requires `admin` or `superadmin` role.

Request:
```jsonc
{
  "folderName": "2025.04.12-13 - PP3 - CCA - JKR",
  "files": [
    { "relativePath": "Morning Session/01_intro.mp3", "sizeBytes": 12345678 },
    { "relativePath": "Morning Session/02_refugio.mp3", "sizeBytes": 23456789 }
    // ...
  ]
}
```

Response: `text/event-stream` (SSE). Event sequence:

```
event: phase
data: {"phase":"scanning"}

event: phase
data: {"phase":"deterministic_parse","totalFiles":247,"totalSessions":24}

event: phase
data: {"phase":"ai_analysis","totalChunks":6}

event: chunk_progress
data: {"done":1,"total":6}
...
event: chunk_failed
data: {"chunkIndex":3,"reason":"rate_limit","willFallback":true}
...
event: result
data: { ...AnalysisResult }
```

If the connection closes before `result`, the server aborts any pending
Claude calls.

### Backend: `AnalysisResult` shape

```ts
{
  aiCoverage: {
    totalTracks: number;
    tracksAnalyzedByAi: number;
    tracksFromDeterministicFallback: number;
    chunks: number;       // total Claude calls attempted
    chunksFailed: number; // chunks that fell back
  };
  event: {
    titleEn: string | null;
    titlePt: string | null;
    startDate: string | null;     // ISO YYYY-MM-DD
    endDate: string | null;
    matchedGroupIds: string[];    // matched against retreatGroups in DB
    matchedTeacherIds: string[];  // matched against teachers in DB
    matchedPlaceIds: string[];    // matched against places in DB
    folderConventionOk: boolean;  // false if folder name deviates
  };
  sessions: Array<{
    sessionNumber: number;
    titleEn: string;              // e.g. "25 April – Morning"
    titlePt: string;
    sessionDate: string | null;   // ISO YYYY-MM-DD
    timePeriod: "morning" | "afternoon" | "evening" | null;
    tracks: Array<{
      position: number;
      originalFilename: string;   // basename of the dropped file
      correctedFilename: string;  // ASCII-safe S3 key suffix
      displayTitleEn: string;
      displayTitlePt: string;     // may carry diacritics
      corrections: Array<{
        field: "filename" | "displayTitleEn" | "displayTitlePt";
        before: string;
        after: string;
        reason: string;           // short explanation
      }>;
    }>;
  }>;
  notes: Array<{
    severity: "info" | "warning";
    message: string;
    relatedFilename?: string;     // basename if note targets a specific file
  }>;
}
```

The Zod schema for this lives in `track-conventions.ts` and is reused for
validating Claude's JSON output.

### Backend: `track-analysis.ts` pipeline

The SSE plumbing lives in the route handler. The service exposes a single
function that takes a progress callback so the route can forward events:

```ts
analyzeFolder(
  input: AnalyzeFolderInput,
  onProgress: (event: ProgressEvent) => void,
  signal: AbortSignal,
): Promise<AnalysisResult>
```

Input:
```ts
{
  folderName: string;
  files: { relativePath: string; sizeBytes: number }[];
  knownGroups: { id: string; nameEn: string; namePt: string; slug: string; abbreviation: string }[];
  knownTeachers: { id: string; name: string; abbreviation: string }[];
  knownPlaces: { id: string; name: string; abbreviation: string }[];
}
```

`ProgressEvent` mirrors the SSE event shapes (`phase`, `chunk_progress`,
`chunk_failed`). The route handler subscribes once and forwards each event
to the client as SSE. `signal` is the request's `AbortSignal`; when the
client disconnects, in-flight Claude calls receive the same signal and
abort.

Pipeline:

1. **Deterministic pre-pass.** Run `parseTrackFile` server-side on every
   filename (no I/O, fast). Run `inferSessions` to get session grouping.
   This output is the fallback structure if AI fails completely, and it is
   sent to Claude as a hint in every chunk.

2. **Decide single-pass vs chunked.** If `files.length <= 80`, one Claude
   call with all files. Otherwise, chunk with a session-boundary
   preference:
   - Target chunk size: 60 tracks. Hard maximum: 80 tracks.
   - Walk sessions in order. For each session:
     - If the session alone exceeds the hard max (degenerate case — a
       single session with too many tracks), split that session into
       sub-chunks of ~60 tracks. Each sub-chunk is tagged
       `{ sessionRef, partIndex, partTotal }` so the prompt can tell
       Claude it's looking at a partial session.
     - Otherwise, pack the session into the current chunk if it fits
       under the hard max; if it would overflow, flush and start a new
       chunk with this session.
   - Result: chunks of 40–80 tracks typically; session boundaries are
     respected whenever possible. Only the first chunk receives the
     folder name and is responsible for event-level metadata; subsequent
     chunks return `event: null` and are merged in.
   - Partial-session chunks are prompted explicitly: "This chunk contains
     part X/Y of session N. Use the deterministic pre-pass for
     session-level fields; correct only the listed tracks." Per-track
     corrections from each sub-chunk are merged by `sessionRef` +
     position; if one sub-chunk fails and falls back, only its tracks
     lose AI corrections — the other sub-chunks of the same session
     keep theirs.

3. **Claude calls.** Concurrency limit = 4 parallel. Each call:
   - `model: "claude-sonnet-4-6"`
   - `max_tokens: 16000`
   - 30s timeout
   - System prompt = role + writing rules from `track-conventions.ts`
   - User prompt = folder name (first chunk only), known groups/teachers/
     places, deterministic pre-pass JSON, chunk's file list, output schema
   - Strict JSON output requested

4. **Per-call error handling:**
   - `stop_reason === "end_turn"` + JSON parses + Zod validates → use it.
   - `stop_reason === "max_tokens"` → split chunk in 2, retry both halves
     once. If still fails → deterministic fallback for this chunk.
   - JSON parse error → retry once with reinforced "strict JSON" instruction.
     If still fails → deterministic fallback for this chunk.
   - 429 rate limit → exponential backoff (2s, 4s, 8s), up to 3 retries.
   - Network error / timeout → 1 retry. Then deterministic fallback.

5. **Merge.** Combine event metadata (first chunk wins; deterministic fills
   gaps), concatenate sessions in order, accumulate notes, compute
   `aiCoverage` from chunk outcomes.

6. **Abort.** If the SSE client disconnects, the orchestrator's
   `AbortController` cancels in-flight `fetch` calls. Done chunks' cost is
   not refunded; that's acceptable (≈ pennies).

### Backend: prompt strategy

Built from `track-conventions.ts` constants + dynamic input.

**System message:**
- Role: "You assist an admin ingesting audio files for a Buddhist retreat
  centre."
- Domain: brief explanation of retreats / sessions / tracks.
- Conventions: folder name format, filename format, writing rules.
- Output: JSON only, matching the provided schema, no prose.

**User message:**
1. The folder name received (first chunk only).
2. The deterministic pre-pass for this chunk (JSON).
3. The list of known groups / teachers / places (id + name + abbreviation)
   so Claude can return matched IDs.
4. The list of files in this chunk (`relativePath` + size).
5. The output JSON schema with explicit instructions:
   "For every field you change relative to the deterministic pre-pass, add
   an entry to `corrections` with `field`, `before`, `after`, `reason`.
   For anything suspicious (orphan file, missing track number, deviation
   from the folder convention, ambiguous date), add an entry to `notes`."

### Why not share `import-inference.ts`?

The two flows have meaningfully different needs:

| Aspect | S3 historical import | Admin drag-drop |
|---|---|---|
| Source data | S3 paths from 10+ years of varied conventions | Fresh drop following an agreed convention |
| Event metadata | Must be inferred from scratch | Must be inferred from a known folder-name format |
| Aggressiveness | Liberal interpretation needed | Conservative, must flag deviations rather than silently fix |
| Input format | Cataloged `importFiles` records | Raw FS entries |
| User interaction | Batch, non-interactive | Interactive review of every correction |

Sharing one prompt would require runtime branches that pollute both code
paths. The shared concerns (writing rules, accent conventions, the Zod
schemas for `corrections` and `notes`) move to `track-conventions.ts` and
are imported by both services. The orchestration and prompt-building stay
separate.

### Admin UI: `TrackDropZone` changes

Today the dropzone has two visual states (empty, files-present). Adds a
third state: **analysing**.

```
┌────────────────────────────────────────────┐
│  ◎ Analyse en cours…                       │
│                                            │
│  ⏳ 247 fichiers détectés, 24 sessions     │
│  🤖 Analyse intelligente : 3 / 6 lots     │
│                                            │
│  [ Annuler ]                                │
└────────────────────────────────────────────┘
```

- Driven by SSE events (`phase`, `chunk_progress`) parsed from the fetch
  response stream. The text updates as events arrive.
- Cancel button calls `AbortController.abort()` on the fetch, which closes
  the stream and resets the dropzone to its empty state.
- Overlay doesn't block the rest of the page (z-index local to the
  dropzone area).

### Admin UI: `SessionPreview` changes

Per-track corrected indicator:
- Track rows with `corrections.length > 0` get a `✨` icon to the left and
  a subtle yellow row background (`#FFF8E1`).
- Below the title, a small caption "N corrections" toggles a panel listing
  each correction as a diff:
  ```
  • displayTitlePt: "Refugio" → "Refúgio"
    typo: missing diacritic
  • filename: "intro 02 refugio.mp3" → "02_refugio.mp3"
    normalisation: numbering + underscores
  ```

AI notes section at the bottom of the preview, above Save/Cancel:
- `⚠` (amber) for `severity: warning`, `ℹ` (gray) for `info`.
- Notes with `relatedFilename` are clickable → scrolls and highlights the
  matching track row.
- Collapsible if more than 5 notes.

Fallback banner (renders above the session list when
`aiCoverage.chunksFailed > 0` or `aiCoverage.tracksAnalyzedByAi === 0`):
- Amber, not red — soft warning, not blocking.
- Copy: explains that AI analysis was unavailable for some or all tracks,
  recommends retrying if non-urgent, warns that typos may slip through if
  the admin proceeds. New translation keys under `padmakara.import.*` in
  the admin's EN and PT locale files (matches existing admin i18n
  convention — no FR locale on the admin side).
- Two buttons: "Réessayer l'analyse IA" (re-POST with same payload),
  "Continuer sans IA" (dismiss banner).

### Admin UI: i18n

New translation keys under `padmakara.import.*` for the EN and PT admin
locale files. Existing pattern (`useTranslate()`) applies.

### Frontend: filename rename at upload

`uploadManager.uploadTracks(eventCode, sessions, ...)` is called after the
event/session/track records are created by the form submission. Today it
loops over each track and presigns using `file.name`. Change: loop carries
both the `File` and the `correctedFilename` (passed in from
`SessionPreview` state), and presigns using `correctedFilename`. The File
body is uploaded unchanged. The track record's `s3Key` is set to the
returned key (already built from `correctedFilename` server-side by
`buildTrackS3Key`).

## Data Model

No schema migrations needed. The corrected filename becomes the track's
`s3Key` directly; the original filename is not persisted.

## Error Handling

### Backend

- **Anthropic rate limit (429)** — exponential backoff (2s, 4s, 8s), then
  per-chunk deterministic fallback.
- **Anthropic timeout / network error** — 1 retry, then per-chunk
  deterministic fallback.
- **Invalid JSON from Claude** — 1 retry with stricter prompt, then
  per-chunk deterministic fallback.
- **`max_tokens` truncation** — split chunk and retry both halves once,
  then deterministic fallback for failures.
- **All chunks fail** — `aiCoverage.tracksAnalyzedByAi = 0`, full
  deterministic result returned. Client shows the fallback banner.
- **SSE client disconnect** — `AbortController` cancels in-flight calls,
  no result is emitted.

### Frontend

- **Network error opening the fetch stream** — show retry button on the
  dropzone with the original file list cached client-side.
- **Server returns 5xx mid-stream** — emit a final `error` SSE event with a
  message, client shows a toast and lets the admin retry.
- **Admin clicks Cancel** — `AbortController.abort()` on the fetch, reset
  to empty dropzone.

## Testing

### Backend (`tests/services/track-analysis.test.ts`, `tests/routes/admin/import.analyze.test.ts`)

Vitest with mocked DB and mocked Anthropic SDK.

Service:
- Single-pass mode (≤80 files), Claude returns valid JSON → result is used.
- Single-pass mode, Claude returns invalid JSON → deterministic fallback,
  `aiCoverage.tracksAnalyzedByAi === 0`.
- Single-pass mode, Claude returns `stop_reason: max_tokens` → split-retry
  path exercised, fallback if still fails.
- Chunked mode (>80 files): all chunks succeed → merge preserves session
  order, event metadata comes from first chunk only.
- Chunked mode: one chunk hits rate limit → backoff exhausted →
  deterministic fallback for that chunk only; other chunks' AI corrections
  preserved; `aiCoverage.chunksFailed === 1`.
- Session boundaries respected when sessions fit under hard max
  (property test on chunker).
- Degenerate case: single session with >80 tracks → split into sub-chunks
  tagged with `partIndex`/`partTotal`/`sessionRef`. Merge recombines
  sub-chunks of the same session in order.
- Partial-session prompt instruction is included only for sub-chunks of
  split sessions, not for whole-session chunks.
- Group/teacher/place abbreviations resolved to DB IDs; unknown
  abbreviations produce no match (empty array) and a `notes` entry.

Route:
- Without auth → 401.
- With non-admin user → 403.
- Invalid payload (missing `folderName`, empty `files`) → 400.
- SSE events emitted in expected order: `phase` × N, `chunk_progress` × N,
  `result` once.
- Client disconnect mid-stream cancels pending Claude calls
  (`AbortController.signal.aborted === true`).

### Admin UI (`admin/src/components/__tests__/...`)

Existing tests in the admin UI use Vitest + Testing Library (per project
testing setup). Add:

`TrackDropZone.test.tsx`:
- Drop on dropzone triggers FS scan and POSTs to
  `/api/admin/import/analyze` with a streaming fetch.
- Spinner overlay renders with progress text reflecting SSE events.
- Cancel button closes EventSource and returns dropzone to empty state.

`SessionPreview.test.tsx`:
- Track with `corrections.length > 0` renders `✨` icon and yellow row
  background.
- Clicking the "N corrections" caption expands the diff panel.
- Notes section renders with correct icons per severity.
- Clicking a note with `relatedFilename` scrolls to and highlights the
  track row.
- Fallback banner renders when `aiCoverage.chunksFailed > 0`.
- "Réessayer l'analyse IA" button re-invokes the analyse flow.

## Observability

Backend log per analysis (single line, structured):

```
[analyze] folderName="..." files=247 sessions=24 chunks=6 chunksFailed=1
          aiTracks=240 deterministicTracks=7 durationMs=24310
          claudeInputTokens=18420 claudeOutputTokens=9210
```

Lets us track cost, latency, and AI degradation in production. Anthropic
usage is also reported to the existing telemetry pipeline if one exists
(deferred — no telemetry layer currently).

## Open Decisions

None. All architecture decisions agreed in brainstorming session 2026-05-20:

| Decision | Choice |
|---|---|
| Claude execution | Backend endpoint `/api/admin/import/analyze` |
| S3 rename | S3 key = corrected filename, original discarded |
| AI fallback | Deterministic parser + banner encouraging retry |
| Service structure | Dedicated `track-analysis.ts` + shared `track-conventions.ts` |
| Report format | Structured per-track corrections + free-text notes |
| Per-track viz | `✨` icon + yellow row + expandable diff panel |
| Correction shape | Array of `{field, before, after, reason}` |
| Model | `claude-sonnet-4-6` |
| Scaling | Adaptive single-pass / chunked, no hard upper limit |
| Progress reporting | SSE |
