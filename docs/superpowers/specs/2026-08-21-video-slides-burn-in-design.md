# Video Title Slides — Editor + Burn-In Pipeline

**Date:** 2026-08-21
**Status:** Approved for autonomous implementation (user delegated all open decisions)

## Goal

Replace hand-made, manually-edited intro/outro title cards with a slide **editor** in the
admin, and an automated pipeline that renders those slides to video and concatenates them
around the master recording before it reaches Bunny Stream.

An admin defines slides once. The system burns them in. Changing a slide later re-runs the
burn from the retained master — no manual video editing, ever.

## Decisions taken autonomously

The user delegated every open question. These are the calls made; each is reversible.

| Decision | Choice | Why |
|---|---|---|
| Slide storage | **JSONB document** on `event_videos`, not relational tables | Slides are always read and written as a whole document. Two tables + ordering columns would be pure overhead. |
| Renderer | **One HTML/CSS renderer** shared by the admin preview and the burn container | Guarantees the preview is exactly what gets burned. A second implementation would drift. |
| Rasteriser | Headless Chromium → PNG per slide | Gives real text layout, real bold/italic from the font files, and image box-fitting for free. `drawtext` cannot do inline mixed styling. |
| Font | **MinionPro** (already in `padmakara-app/assets/fonts/`) | It is what the existing reference slides are set in, and it ships Regular/Italic/Bold/BoldItalic as real files. |
| Concat strategy | Render intro/outro to **match the master's codec params** (probed with `ffprobe`), then concat with `-c copy`; fall back to full re-encode if validation fails | Avoids a 90-minute re-encode. The fallback keeps it correct when a master has unusual parameters. |
| Delivery to Bunny | Merged output → S3 → Bunny `fetchVideo()` with a presigned URL | Reuses the exact path `scripts/import-s3-videos.ts` already proves in production. No TUS client needed in the container. |
| Per-line size | Added (`sm` / `md` / `lg` / `xl`) | The reference slides mix label-size and value-size text inside one slide (slides 4 and 5). Without it they cannot be reproduced. |
| Horizontal rule on slide 4 | A normal text line containing an em-dash | No new line type needed. |
| Language | **Bilingual, matching the existing archive** | A burned card is one language per file. The existing slides are simultaneously bilingual ("Organizer \| Organizador"), so the default template preserves that. Per-language variants are possible later by generating N intros; not built now. |

## Slide document model

Stored on `event_videos.slides` as JSONB:

```jsonc
{
  "version": 1,
  "intro": [ Slide, ... ],
  "outro": [ Slide, ... ]
}
```

```typescript
type Slide = {
  id: string;              // stable uuid, for React keys and reordering
  durationMs: number;      // default 4000
  fadeMs: number;          // default 800, fade to/from black between slides
  lines: Line[];
};

type Line =
  | { id: string; type: "text";  spans: Span[]; size: Size; dim?: boolean }
  | { id: string; type: "image"; s3Key: string; alt?: string }
  | { id: string; type: "spacer" };

type Span = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };
type Size = "sm" | "md" | "lg" | "xl";
```

**Layout rules (fixed, not configurable):**
- Background is always pure black `#000000`. Not editable.
- Text is white. `dim: true` renders at 75% opacity (matches the date slide in the reference).
- The whole line stack is centred **both** vertically and horizontally. With more lines, they
  distribute vertically as a centred block — never top-anchored.
- An `image` line takes the vertical space left over after all text lines are laid out,
  preserving aspect ratio, capped at 60% of frame height.
- Multiple image lines share the leftover space equally.

## Default templates

Generated on demand from event metadata, mirroring the existing Tenga Rinpoche intro exactly.

**Intro — 5 slides:**

| # | Content | Source |
|---|---|---|
| 1 | Teacher name | `event_teachers` → `teachers.name` (all teachers, one line each) |
| 2 | Event type, italic | `events.eventTypeId` → `event_types.nameEn` / `namePt` |
| 3 | Date in English, then Portuguese, dimmed | `event_videos.videoDate` ?? `events.startDate` |
| 4 | `Organizer \| Organizador` + org name, em-dash rule, `Place \| Local` + place | New `events.organizer` field; `event_places` → `places.name` / `location` |
| 5 | Credits label (italic), credit name (bold), spacer, `©` line | New global settings, per-event override |

**Outro — 1 slide:** the Padmakara logo, centred, nothing else.

Two new pieces of data are required and are added by this work:
- `events.organizer` (text, nullable) — falls back to a global default.
- Global settings for the credits block and copyright holder, with per-event override.

## Pipeline

```
Admin picks file
  → gate: slides defined OR "already has burnt-in slides" ticked
  → browser uploads master to S3 (presigned PUT)          [replaces direct-to-Bunny TUS]
  → API submits AWS Batch job
      container: pull master → ffprobe → render slides → encode intro/outro
                 → concat → upload merged to S3 → Bunny fetchVideo(presigned)
      → POST completion webhook
  → API sets bunnyVideoId, burnStatus=done
```

When **"already has burnt-in slides"** is ticked, slide definition is skipped entirely and the
upload takes the existing direct-to-Bunny path unchanged.

**Schema additions on `event_videos`:**

| Column | Type | Purpose |
|---|---|---|
| `slides` | `jsonb` nullable | The slide document |
| `has_burned_slides` | `boolean` default false | Admin asserts the file already contains slides; skips the pipeline |
| `burn_status` | `text` | `pending` / `queued` / `processing` / `done` / `failed` |
| `burn_job_id` | `text` nullable | AWS Batch job id, for reconciliation |
| `master_s3_key` | `text` nullable | Retained master, so re-burns never lose a generation |
| `burn_error` | `text` nullable | Failure reason surfaced in the admin |

Mirrors the existing `subtitle_jobs` / `read_along_jobs` lifecycle, including reconciliation of
non-terminal rows against Batch's real state.

## Re-burn on edit

Editing slides on a video that already burned sets `burn_status = pending` and offers a
"Re-burn" action. The job re-runs from `master_s3_key`, produces a new Bunny video, and swaps
`bunny_video_id` on the **existing row** — so `video_progress` and bookmarks, which key on
`event_videos.id`, survive untouched.

**Known consequence:** the intro length may change between burns, which shifts every saved
resume position by the delta. Mitigation: store the burned intro duration and offset stored
positions when it changes. Tracked as a follow-up, not built in v1.

## Testing

- **Pure functions** (Vitest): slide document validation, default-template generation from
  event metadata, HTML generation from a slide document, ffmpeg argument construction.
- **Renderer** (Vitest + Playwright, already a dev dependency): render each reference slide,
  assert on layout invariants (single centred block, correct line count, image fits).
- **Pipeline** (local): a short real master through the full render → concat path using the
  ffmpeg/ffprobe on the dev machine, asserting output duration equals the sum of parts and
  the stream copy did not re-encode.
- **Admin editor**: component tests for add/remove/reorder slide and line, and the upload gate.

## Requires user action (cannot be automated from here)

AWS provisioning must be done with account access:
1. Build and push the burn container image to ECR.
2. Create the Batch job definition and attach it to the existing job queue.
3. Grant the job role `s3:GetObject` / `s3:PutObject` on the master and output prefixes.
4. Set `BURN_JOB_DEFINITION` / `BURN_JOB_QUEUE` in the server `.env`.

A runbook is written alongside the container source.

---

## Appendix A — Constraints discovered during implementation

These were found by reading the existing code and materially shaped the design.

**AWS Batch caps `containerOverrides` at 8192 bytes.** A slide document with images and
many lines can exceed that. `src/services/read-along.ts` already hit this ceiling with track
lists and solved it by writing the payload to S3 and passing only `AUDIO_KEYS_S3_KEY`. The
burn job follows that precedent exactly: the slide document is written to
`video-burn/{videoId}/slides.json` and passed as `SLIDES_S3_KEY`.

**The existing Batch container is not in this repository.** The read-along / subtitle
container is external Python (`run_job.py`, `subtitle_job.py`), with no Dockerfile, no ECR
URI and no provisioning runbook anywhere in the repo. That is a gap, not a pattern worth
copying — the burn container's source lives in-repo under `containers/video-burn/`, with a
provisioning runbook alongside it.

**Batch job definition and queue are shared today.** `config.readAlong.jobDefinition` and
`jobQueue` serve both read-along and subtitles, differentiated at runtime by a `JOB_MODE`
env var. The burn job needs a different image (ffmpeg + Chromium, not Whisper), so it gets
its own job definition (`BURN_JOB_DEFINITION`) while reusing the existing queue by default.

**Webhook auth is HMAC-SHA256 over the raw body** in `X-Webhook-Signature`, keyed on
`config.readAlong.webhookSecret`, with handlers always returning 200 so the container never
retries into a loop. The burn webhook copies this faithfully.

**Reconciliation runs on admin poll, not on a schedule.** `batch-reconcile.ts` reconciles
non-terminal rows against `DescribeJobsCommand` whenever the admin lists jobs, with a 2-minute
grace period for a late webhook and a 15-minute aged-out threshold. Burn rows join the same
mechanism.

**Uploads currently bypass the backend entirely** — the browser TUS-uploads straight to Bunny
and the API only mints credentials. Burn-in requires a retained master, so the gated path
uploads to S3 first instead. The existing `POST /api/admin/videos/import-url` route already
proves the S3-presign → `fetchVideo()` ingestion path end to end; the burn container reuses it.

## Appendix B — Integration contract

Fixed up front so the schema, API, admin UI and container could be built in parallel.

```
GET   /api/admin/videos/:id/slides
      → { slides, hasBurnedSlides, burnStatus, burnError, burnedIntroMs }

PUT   /api/admin/videos/:id/slides
      { slides }  → same shape.  Resets burnStatus to 'pending' when it was 'done'.

POST  /api/admin/videos/:id/slides/defaults
      → { slides }   generated from event metadata, NOT persisted

PATCH /api/admin/videos/:id
      additionally accepts { hasBurnedSlides, masterS3Key }

POST  /api/admin/upload/video/presign
      { eventCode, filename, contentType } → { s3Key, uploadUrl }   (12h TTL)

POST  /api/webhooks/video-burn
      HMAC-signed. { jobId, videoId, status, bunnyVideoId?, introMs?, outroMs?, error? }
      On success: swaps bunny_video_id ON THE EXISTING ROW so progress and bookmarks survive.
```

`burn_status` values: `none | pending | queued | running | done | failed`.

## Appendix C — Decisions taken during integration

**Two upload paths, not one.** The gate does not merely block an upload; it selects between
two fundamentally different pipelines:

| Admin declares | Path |
|---|---|
| Slides defined | Browser presigns and PUTs the master to **S3**, backend creates the row and submits the Batch burn job, container merges and hands the result to Bunny. Master is retained for re-burns. |
| "Already has burnt-in slides" | The **existing** TUS-direct-to-Bunny path, unchanged. `has_burned_slides` is recorded on the row so it is clear why it carries no slides of ours. |

`uploadVideoMaster()` in `admin/src/utils/videoUploader.ts` implements the first;
`uploadVideoFile()` is the second and now returns the created row id so the flag can be
persisted.

**`event_videos.bunny_video_id` is now nullable** (migration `0037`). A video in the burn
pipeline exists as a row — holding its master key, slide document and burn status — before
its Bunny video exists. The alternative, a placeholder guid, would have been a lie that
every lookup had to special-case.

Making it nullable let the type checker enumerate every read site rather than leaving them
to be discovered in production. All seven were handled:

- `media.ts` playback and MP4 download → `409 Conflict`, "still being processed"
- `services/subtitles.ts` → refuses to queue transcription before a burn completes, since
  it transcribes from the Bunny-hosted audio
- `routes/admin/videos.ts` delete → the Bunny ref-count cleanup is skipped when there is no
  guid to clean up

**Burn resolves at queue time, not completion.** `uploadVideoMaster()` returns as soon as the
Batch job is queued. A 90-minute master takes tens of minutes to merge and re-transcode, and
holding the admin's upload dialog open for that would be unusable. `burn_status` on the row
carries the rest, surfaced as a chip in the video list.

## Appendix D — Revisions after first admin review (2026-08-21)

**Upload is now a single modal.** The first cut put an ambient "already has slides burnt in"
checkbox and a "Define slides" link in the video section's footer, describing a video that did
not exist yet. Replaced by one **Add video** dialog: choose *Add title slides* or *Already burnt
in* first, then a drag-and-drop / click-to-browse zone with "or import from a URL" beneath.
Nothing in the file step is enabled until the slide decision is made.

**URL import can be burned too.** Previously URL import handed the link straight to Bunny's
`fetchVideo()`, so no master reached S3 and burning was impossible. The burn container now
accepts `MASTER_SOURCE_URL` as an alternative to `MASTER_S3_KEY`: it downloads the file itself,
uploads the untouched original to `video-burn/{videoId}/master{ext}`, and reports that key back
in the webhook. Deliberately done in the container rather than the API server so multi-GB
downloads never transit the production box.

**Slide defaults are event-scoped, not video-scoped.** The generator originally lived only at
`POST /admin/videos/:id/slides/defaults`, which made it unusable in the pre-upload draft editor —
a chicken-and-egg, since slides must exist *before* the video they are burned into.
`POST /admin/events/:id/slides/defaults` was added, with both routes sharing
`fetchSlideTemplateMetadata()` so they cannot drift. The video-scoped route still prefers the
video's own `videoDate`; the event-scoped one falls back to `events.startDate`.

**Subtitles refuse to run transcript-blind.** `submitSubtitleJob` passes `TRANSCRIPT_PREFIX` to
the container, which uses those transcripts to guide Whisper — but nothing verified they
existed, so an event without transcripts silently produced raw-Whisper output on Tibetan
Buddhist terminology. `hasTranscriptForLanguage()` now requires a matching-language row with a
non-null `s3Key`, enforced **inside the service** rather than at the route so it cannot be
bypassed by calling the API directly. Generation proceeds only with an explicit
`acknowledgeNoTranscript: true`, which the admin sends after a confirmation dialog stating the
accuracy cost.

Generation moved to `POST /admin/subtitle-jobs` (the only path that can carry the
acknowledgement); the superseded `POST /admin/videos/:videoId/subtitles` was removed rather than
left as a route that silently fails closed. Listing, download and translate remain video-scoped.

**Batch jobs can be cancelled.** `terminateBatchJob()` wraps `TerminateJobCommand` for both
subtitle and read-along jobs and deliberately does not throw when Batch reports the job already
finished. Cancelled rows are marked `failed` with "Cancelled by an administrator" rather than
gaining a new `cancelled` status — which avoided touching every consumer of the status field,
at the cost of a cancelled job being distinguishable from a real failure only by its message.
Worth revisiting if cancellation becomes common.
