# video-burn container

AWS Batch job container for the title-slide burn-in pipeline. Given a
retained master recording and an admin-authored slide document, it renders
the intro/outro title cards, encodes them to match the master's exact
codec parameters, concatenates everything, and hands the result to Bunny
Stream — replacing hand-edited intro/outro cards with a fully automated
pipeline.

See the design doc for the full picture:
`docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md` (repo root).

## Layout

```
containers/video-burn/
  entrypoint.ts       orchestration: the whole pipeline, step by step
  ffmpeg-plan.ts       PURE functions: ffmpeg arg construction, timing maths
                        (also imported directly by the backend's Vitest
                        suite — tests/services/video-burn.test.ts — so it
                        has zero Node-specific imports)
  s3-client.ts         S3 download/upload/presign helpers
  bunny-client.ts       minimal reimplementation of the two Bunny Stream API
                        calls this container needs (fetch + set-thumbnail)
  webhook.ts            HMAC-signed completion webhook POST
  fonts/                 the four MinionPro faces, copied from
                        padmakara-app/assets/fonts/ (Regular/It/Bold/BoldIt)
  assets/                 bundled default outro logo (padmakara-logo.png,
                        copied from padmakara-app/assets/images/logo.png)
  package.json, tsconfig.json   this container's own, separate dependency graph
  Dockerfile
```

`entrypoint.ts` imports the SAME slide renderer the admin preview uses —
`src/lib/slides/render.ts` (and `types.ts`, `defaults.ts`) — via a relative
import (`../../src/lib/slides/...`), so a slide can never render
differently in the burned video than it did in the admin's preview. That
only works because the Docker build **preserves the real repo layout**
inside the image (see "Building" below) — do not flatten the directory
structure when changing the Dockerfile.

## Pipeline, step by step

1. Download the master recording (`MASTER_S3_KEY`) from S3 to `/tmp`.
2. `ffprobe` it → width, height, fps, pixel format, video codec/profile,
   audio codec/sample-rate/channels, duration.
3. Download the slide document (`SLIDES_S3_KEY`) and any S3-backed image
   lines it references. Lines using the builtin sentinel key
   (`@builtin/padmakara-logo.png`) resolve to the bundled `assets/` copy
   instead — see "Builtin outro logo" below.
4. Render each intro/outro slide to HTML via `renderSlideHtml()` and
   screenshot it with headless Chromium at the master's real resolution.
5. Encode each slide PNG to a video segment matching the master's exact
   params, with a fade in from black, a hold, a fade out to black
   (`slide.fadeMs` / `slide.durationMs`), and a **silent** audio track
   (`anullsrc`) matching the master's audio params — every segment needs
   matching streams for the concat step to be able to stream-copy.
6. Concatenate intro segments + master + outro segments with the ffmpeg
   concat demuxer, `-c copy` (fast, no re-encode).
7. **Validate**: `ffprobe` the merged output and check its duration is
   within ±0.5s of the sum of the parts. If the stream-copy concat somehow
   produced a bad result (mismatched params slipped through), retry once
   with a full re-encode and log loudly that it fell back. If that ALSO
   fails validation, the job fails — better a loud failure than a silently
   wrong video.
8. Upload the merged file to `OUTPUT_S3_KEY`, presign a 6h GET on it (same
   TTL convention as `src/scripts/import-s3-videos.ts`), and hand that URL
   to Bunny's `/videos/fetch` endpoint to ingest it. This is the same
   "presign in S3, let Bunny pull it" shape used everywhere else in this
   codebase — no TUS client needed in the container.
9. **Poster thumbnail** (see below) — extracted from the MASTER, not the
   merged file.
10. POST the completion webhook, HMAC-signed with `WEBHOOK_SECRET`. On any
    failure at any step, POST a `status: "failed"` webhook with the error
    message and exit non-zero.

## Why the poster thumbnail step exists

Once an intro is burned in, the merged video no longer starts with real
content — it starts with a black title card (or several). Bunny Stream
auto-generates a poster thumbnail from an early frame of whatever video it
ingests, so **every burned video would otherwise get a black (or
black-with-text) poster**, and the app's video grid
(`padmakara-app/components/VideoGrid.tsx`) renders `video.posterUrl`
directly as the card image — a black grid.

Fix: after `ffprobe`-ing the master (step 2), before the intro is even
rendered, we know the master's own duration. `computeThumbnailOffsetSeconds()`
in `ffmpeg-plan.ts` picks a timestamp **10% into the master's duration,
clamped to at least 3 seconds** — reliably real content, not a fade-up from
black or a few seconds of dead air at the very start of a raw recording.
`ffmpeg -ss <offset> -i master.mp4 -frames:v 1 ...` grabs that one frame,
it's uploaded to S3, presigned, and handed to Bunny's `/thumbnail` endpoint
via its `thumbnailUrl` fetch parameter — the same "presign + let Bunny
fetch" shape used for the merged video itself.

**Why not a `thumbnailTime` field instead** (letting Bunny pick the frame
itself, avoiding an extra upload)? Verified against Bunny's API reference
(`docs.bunny.net/reference/video_update` and
`docs.bunny.net/reference/video_setthumbnail`): there is no time-offset
field on the video object. Only a direct image upload or a `thumbnailUrl`
fetch are supported. The explicit-extract-and-upload path is the only
unambiguous option.

**Failure handling**: the thumbnail step is wrapped in its own try/catch.
If it fails for any reason, the job does **not** fail — the merged video is
still good, and a missing/wrong poster is a cosmetic issue an admin can
fix by re-triggering, not a reason to lose an otherwise-successful multi-GB
render. The failure is logged loudly and reported back as a `warning`
field on the (still `"completed"`) webhook payload.

**Verification**: after any change here, or after standing up the
pipeline for the first time, actually open the app's video grid and
confirm the poster is a real frame, not black. This is also called out in
`docs/runbooks/video-burn-provisioning.md`'s verification checklist.

## Builtin outro logo

The default outro slide is a single centred Padmakara logo. Rather than
requiring every event to have that logo uploaded to object storage, it
ships baked into this container image at `assets/padmakara-logo.png`
(copied from `padmakara-app/assets/images/logo.png`), referenced by the
sentinel key `@builtin/padmakara-logo.png` (`BUILTIN_LOGO_KEY` in
`src/lib/slides/defaults.ts`).

`entrypoint.ts`'s `resolveImageUrl` (passed to `renderSlideHtml()`) checks
`isBuiltinKey()` **before** attempting any S3 download — a builtin key is
never fetched from the bucket, and if the bundled file is somehow missing
from the image the job fails loudly with the missing filename rather than
rendering a broken-image box into a burned, effectively-permanent video.

`BURN_OUTRO_LOGO_S3_KEY` (backend config, `config.videoBurn.outroLogoS3Key`)
exists only to **override** the bundled logo with one stored in the app
bucket — e.g. a group-specific variant. Blank (the default) means "use the
builtin". This is a backend/admin-side concern (which key ends up in the
slide document's outro image line) — the container itself just renders
whatever key it's given, builtin or not.

## Re-burn semantics

A slide edit on a video that already burned successfully triggers a
re-burn from the retained master (`event_videos.master_s3_key`), producing
a **new** Bunny video that replaces `bunny_video_id` on the **same**
`event_videos` row — `video_progress` and `video_subtitles` key on
`event_videos.id`, not the Bunny guid, specifically so they survive that
swap.

The wrinkle: the new burn's intro can be a different length than the old
one (a slide added/removed, a duration changed). Everything that was timed
against the OLD merged file's timeline is now off by exactly that delta.
This container has no idea what the previous intro length was — it always
computes and reports its own `introMs` — so the correction lives entirely
in the **backend webhook handler**
(`src/routes/webhooks.ts` → `POST /api/webhooks/video-burn`,
`computeIntroDelta` / `applyIntroDeltaInTransaction` in
`src/services/video-burn.ts`), not here:

- `video_progress.position_seconds` is shifted by the delta (clamped at 0
  and at the row's own duration when known) — a saved resume position
  should still land in roughly the same *content*, before or after the
  intro changed length.
- `video_subtitles` rows are marked `stale = true` — their VTT cues are
  absolute-timed from the start of the merged video and cannot be
  auto-corrected; the admin re-runs the subtitle job instead.
- Both happen in the same DB transaction as the `event_videos` row update,
  so a crash mid-way can never leave the row pointing at the new Bunny
  video while progress/subtitles still reflect the old timeline.
- On a video's **first** successful burn (no previous `burned_intro_ms`),
  neither applies — there is nothing yet to desync.

If you're touching this container and wondering why the completion webhook
payload always carries `introMs`: this is why. It's not decorative — it's
the only signal the backend has to detect and correct a re-burn's timeline
shift.

## Environment variables

Per-job, set by `submitVideoBurnJob()` (`src/services/video-burn.ts`) via
AWS Batch `containerOverrides`:

| Var | Meaning |
|---|---|
| `JOB_ID` | per-attempt id, for logging/webhook correlation |
| `VIDEO_ID` | `event_videos.id` |
| `MASTER_S3_KEY` | retained master recording |
| `SLIDES_S3_KEY` | slide document JSON (too large for containerOverrides directly — see the design doc's 8192-byte constraint) |
| `OUTPUT_S3_KEY` | where to upload the merged file |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | object storage, same shape as every other pipeline container (`storageEnvForContainer()`) |
| `TITLE` | Bunny video title |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | completion callback |

Static, set once on the **job definition** (see the provisioning runbook —
these are secrets shared by every job, not per-invocation data):

| Var | Meaning |
|---|---|
| `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY` | Bunny Stream credentials |

## Building

Build context must be the **`padmakara-api` repo root**, not this
directory, because the image needs `src/lib/slides/`:

```bash
cd padmakara-api
docker build -f containers/video-burn/Dockerfile -t padmakara-video-burn .
```

## Testing locally

The pure planning logic (`ffmpeg-plan.ts`) is unit tested from the backend
suite — no Docker needed:

```bash
cd padmakara-api
bun test tests/services/video-burn.test.ts
```

To exercise the full pipeline against a real short clip, run the container
with S3 credentials and a real Bunny sandbox library, then check the log
for `FALLBACK:` lines (stream-copy validation failing) and confirm the
Bunny poster is not black:

```bash
docker run --rm \
  -e JOB_ID=local-test \
  -e VIDEO_ID=1 \
  -e MASTER_S3_KEY=events/TEST/masters/sample.mp4 \
  -e SLIDES_S3_KEY=video-burn/1/slides.json \
  -e OUTPUT_S3_KEY=video-burn/1/merged.mp4 \
  -e S3_BUCKET=... -e S3_ENDPOINT=... -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... -e S3_REGION=... \
  -e TITLE="Local test" \
  -e WEBHOOK_URL=http://host.docker.internal:3000/api/webhooks/video-burn \
  -e WEBHOOK_SECRET=dev-webhook-secret \
  -e BUNNY_STREAM_LIBRARY_ID=... -e BUNNY_STREAM_API_KEY=... \
  padmakara-video-burn
```

Running `entrypoint.ts` directly on a dev machine (no Docker) also works
as long as `ffmpeg`/`ffprobe` and a Chromium binary are on `PATH` /
`CHROMIUM_PATH`:

```bash
cd containers/video-burn
npm install
CHROMIUM_PATH=$(which chromium || which chromium-browser) \
  npx tsx entrypoint.ts   # with the same env vars as above
```
