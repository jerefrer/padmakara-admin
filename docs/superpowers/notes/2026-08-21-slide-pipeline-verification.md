# Slide burn-in pipeline — local verification report

**Date:** 2026-08-21
**Scope:** Unit tests for `src/lib/slides/defaults.ts` and `src/lib/slides/render.ts`, plus a
standalone local proof of the render → encode → concat pipeline described in
`docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md`.

**Bottom line: the `-c copy` stream-copy concat works.** Given a segment encoder that derives
every codec parameter from `ffprobe`-ing the real master (rather than hardcoding them), the
concat demuxer produces a file that decodes cleanly end to end, has the correct total duration,
and never triggers a re-encode. The only residual imperfection is a ~21-microsecond duplicate
audio timestamp at every segment boundary — inherent to splicing independently-encoded AAC
files, harmless in practice, and not something `-c copy` can avoid. Full detail below.

Three unrelated but real bugs were found along the way and are documented, not silently
worked around: a Playwright `file://` image-loading gap, a filename mismatch between
`buildDefaultOutro()`'s builtin-logo convention and the actual asset, and the bundled logo
being nearly invisible against the mandatory black slide background.

---

## 1. Unit tests

- `tests/lib/slides/defaults.test.ts` — 37 tests. Covers `formatDateEn`/`formatDatePt`
  (valid dates, malformed strings, month 00/13), the exact 5-slide reference intro sequence
  from full metadata (asserted with a deterministic counter `IdFactory`, `id-0`, `id-1`, …),
  per-slide omission when its source data is absent, the bilingual event-type collapse rule,
  the em-dash rule (only when both organizer and place exist), the copyright-year default
  (via `vi.useFakeTimers`/`vi.setSystemTime`), and the new builtin-logo fallback
  (`BUILTIN_PREFIX`, `BUILTIN_LOGO_KEY`, `isBuiltinKey`, `builtinFilename`) added to
  `defaults.ts` mid-task.
- `tests/lib/slides/render.test.ts` — 24 tests. Covers HTML escaping of `<`, `&`, quotes
  (explicitly asserting the dangerous raw substring is absent, not just that an escaped one is
  present — this is a real XSS vector in the admin preview iframe), nested
  `<u><em><strong>` emphasis ordering, `html{font-size:height/100 px}` exactness, the
  documented size scale (`sm`→3rem, `md`→4rem, `lg`→5rem, `xl`→6.5rem), image URL resolution
  via `resolveImageUrl`, spacer rendering, the zero-width-space fallback for empty text lines,
  dim-class application, and all four `@font-face` blocks pointing at `fontBaseUrl`.

Both files pass under the project's real test command:

```
$ bun run test -- tests/lib/slides/defaults.test.ts tests/lib/slides/render.test.ts
 ✓ tests/lib/slides/render.test.ts (24 tests) 5ms
 ✓ tests/lib/slides/defaults.test.ts (37 tests) 10ms
 Test Files  2 passed (2)
      Tests  61 passed (61)
```

**Pre-existing, unrelated finding:** `bun run typecheck` currently fails on
`src/lib/slides/defaults.ts` (12 errors, all `Argument of type '"xl"' is not assignable to
parameter of type 'never'` and similar) because the `textLine()` helper's conditional type
`Line extends { size: infer S } ? S : never` doesn't distribute the way the author intended
over the `Line` union in this position, so TypeScript infers `never` for the `size` parameter.
It also fails on unrelated pre-existing errors in `src/routes/admin/publications.ts` and
`src/routes/media.ts` (Bun `Uint8Array`/`BlobPart` typing). None of this is caused by the test
files added here — `defaults.ts`/`render.ts`/`types.ts` are explicitly out of scope for this
task ("the code under test EXISTS — do not modify it") — but it's worth fixing separately since
it means `defaults.ts` currently fails `tsc --noEmit` on every commit.

---

## 2. Pipeline verification script

`scripts/verify-slide-pipeline.ts` — standalone, not part of `bun test`. Run with:

```
bun run scripts/verify-slide-pipeline.ts
```

It was run for real, multiple times, on this machine (real `ffmpeg`/`ffprobe` at
`/opt/homebrew/bin`, real headless Chromium via Playwright). Final canonical run's full console
output:

```
Working directory: <scratch>/slide-pipeline-verify-1787268681821

=== 1. Generating synthetic master video ===
Generated <scratch>/slide-pipeline-verify-1787268681821/master.mp4 in 657ms

=== 2. Probing master with ffprobe ===
Master params derived for segment encoding:
{
  "width": 1280,
  "height": 720,
  "rFrameRate": "25/1",
  "pixFmt": "yuv420p",
  "videoCodec": "libx264",
  "profile": "high",
  "level": "4.0",
  "durationSec": 10,
  "audioCodec": "aac",
  "sampleRate": 48000,
  "channels": 2,
  "channelLayout": "stereo"
}

=== 3. Building default slide document from realistic metadata ===
Intro: 5 slides. Outro: 1 slide(s).

=== 4. Rendering slides to HTML and screenshotting with headless Chromium ===
Rendered + screenshotted 6 slides in 222ms

=== 5. Encoding each slide PNG to a video segment matching the master ===
Encoded 6 segments in 1578ms

=== 6. Concatenating intro segments + master with the concat demuxer (-c copy) ===
Concat completed in 50ms
NOTE — concat stderr (non-fatal warnings)
       [aost#0:1/copy @ 0x8c3078000] Non-monotonic DTS; previous: 269312, current: 268800; changing to 269313.
       [aost#0:1/copy @ 0x8c3078000] Non-monotonic DTS; previous: 538112, current: 537600; changing to 538113.
       [aost#0:1/copy @ 0x8c3078000] Non-monotonic DTS; previous: 806912, current: 806400; changing to 806913.
       …(truncated, see notes doc)
Bonus full concat (intro+master+outro) completed in 57ms

=== 7. Verifying the concatenated output ===
PASS — (a) duration == master + total intro duration, within ±0.5s
       expected 38.000s (master 10.000s + intro 28.000s), got 38.021s, delta 0.021s
PASS — (b) video stream not re-encoded (container-level codec/profile/level/pix_fmt/resolution/fps match master)
       output: codec=h264 profile=High level=40 pix_fmt=yuv420p 1280x720 @25/1
PASS — (b-spot-check) decoded frame dimensions match master on both sides of the join
       intro-side frame 1280x720, master-side frame 1280x720, expected 1280x720
PASS — (full decode) entire concatenated file decodes with no error/invalid/corrupt lines
       clean decode, zero warnings of concern
PASS — (c) audio continuous across every join (no gap > 4x the AAC frame cadence)
       1790 audio packets, max consecutive delta within tolerance; 5 harmless near-duplicate timestamp bump(s) at segment joins

=== 8. Extracting a mid-slide frame from every intro and outro slide for visual QA ===
  intro slide 0: mid-frame @ 2.80s
  intro slide 1: mid-frame @ 8.40s
  intro slide 2: mid-frame @ 14.00s
  intro slide 3: mid-frame @ 19.60s
  intro slide 4: mid-frame @ 25.20s
  outro slide 0: mid-frame @ 2.80s (own segment)
NOTE — outro logo visibility (asset/design observation, not a pipeline bug)
       Average channel brightness of the outro frame is 0.04/255. …

=== 9. PASS/FAIL summary ===
PASS — (a) duration == master + total intro duration, within ±0.5s
PASS — (b) video stream not re-encoded (…)
PASS — (b-spot-check) decoded frame dimensions match master on both sides of the join
PASS — (full decode) entire concatenated file decodes with no error/invalid/corrupt lines
PASS — (c) audio continuous across every join (…)

Timings:
  generateMaster: 657ms
  renderAndScreenshot: 222ms
  encodeSegments: 1578ms
  concat: 50ms

All checks PASSED.
```

Total wall-clock for the whole script: well under 3 seconds (excluding Chromium's one-time
launch). This is a 10-second master with a 5-slide + 1-slide default template; a real ~90-minute
master would dominate the `generateMaster`-equivalent stage (which in production is "download
the real master", not "synthesize one") but the render/encode/concat stages scale with the
*slide* count, not the master's length — encoding six ~5.6s slide segments took 1.6s total.

### Real `ffprobe` output — synthetic master (evidence)

```json
{
  "streams": [
    {
      "codec_name": "h264", "profile": "High", "codec_type": "video",
      "width": 1280, "height": 720, "pix_fmt": "yuv420p", "level": 40,
      "r_frame_rate": "25/1", "avg_frame_rate": "25/1", "time_base": "1/12800",
      "duration": "10.000000", "nb_frames": "250",
      "tags": { "encoder": "Lavc63.1.101 libx264" }
    },
    {
      "codec_name": "aac", "profile": "LC", "codec_type": "audio",
      "sample_fmt": "fltp", "sample_rate": "48000", "channels": 2,
      "channel_layout": "stereo", "initial_padding": 1024,
      "time_base": "1/48000", "duration": "10.000000", "nb_frames": "470"
    }
  ],
  "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.000000" }
}
```

### Real `ffprobe` output — concatenated `intro-plus-master.mp4` (evidence)

```json
{
  "format": { "duration": "38.021333" },
  "streams": [
    { "codec_type": "video", "codec_name": "h264", "profile": "High",
      "width": 1280, "height": 720, "pix_fmt": "yuv420p", "r_frame_rate": "25/1" },
    { "codec_type": "audio", "codec_name": "aac", "profile": "LC",
      "sample_rate": "48000", "channels": 2 }
  ]
}
```

Container-level metadata for the concatenated file is byte-identical in kind to the master's —
same codec, profile, level, pix_fmt, resolution, frame rate. No re-encode occurred (confirmed
independently by the fact the whole concat completed in 50ms; a real re-encode of even a 10s
clip takes far longer than that).

### Extracted frames (paths from the final run — see "Artifact paths" below)

- `frames/intro-{0..4}-mid.png` — one frame from the middle of each of the 5 intro slides,
  pulled from *inside the concatenated output*, not the pre-concat segment — i.e. this is the
  actual joined file, not a proxy.
- `frames/outro-0-mid.png` — the outro's logo slide, pulled from its own encoded segment (the
  outro isn't part of the intro+master concat the spec's duration formula covers — see
  "outro handling" below).
- `frames/spot-check-intro.png` / `frames/spot-check-master.png` — used programmatically by
  check (b-spot-check), also useful for a human to eyeball.

All frames were visually reviewed. Slide 1 (teacher name, MinionPro, `xl`), slide 4
(organizer/place with the em-dash rule), and slide 5 (credits + copyright) all render
correctly with real MinionPro glyphs, correct emphasis, and correct centring. The master-side
frame is the `testsrc` pattern, confirming the join lands in the right place.

---

## 3. The exact ffmpeg invocations that succeeded

**Master (synthetic, stand-in for a real uploaded master):**

```
ffmpeg -y -hide_banner -loglevel warning \
  -f lavfi -i "testsrc=size=1280x720:rate=25:duration=10" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" \
  -pix_fmt yuv420p -c:v libx264 -profile:v high -level:v 4.0 -g 50 -keyint_min 50 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart \
  master.mp4
```

**Per-slide segment** (parameters derived from probing the master above — this is the general
form the script builds, shown instantiated for one 5.6s slide with 800ms fades):

```
ffmpeg -y -hide_banner -loglevel warning \
  -loop 1 -i slide.png \
  -f lavfi -i "anullsrc=r=48000:cl=stereo" \
  -t 5.600 \
  -vf "fade=t=in:st=0:d=0.800:color=black,fade=t=out:st=4.800:d=0.800:color=black,format=yuv420p" \
  -r 25/1 \
  -c:v libx264 -profile:v high -level:v 4.0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart \
  segment.mp4
```

**Concat (the operative step):**

```
# concat-list.txt:
#   file 'intro-0.mp4'
#   file 'intro-1.mp4'
#   file 'intro-2.mp4'
#   file 'intro-3.mp4'
#   file 'intro-4.mp4'
#   file 'master.mp4'
ffmpeg -y -hide_banner -loglevel warning -f concat -safe 0 -i concat-list.txt -c copy out.mp4
```

---

## 4. Which master parameters must match for `-c copy` to hold — and what happens when they don't

This is the part the task asked to be investigated precisely rather than assumed. Three
deliberate mismatch experiments were run against the working pipeline above (same 5-segment
intro + master setup, one segment altered per experiment). All three "succeeded" in the sense
that `ffmpeg -f concat -c copy` **exited 0 in every case, with no hard error** — which is itself
the headline finding: **the concat demuxer's `-c copy` path does not validate that segments'
parameters match.** It splices the encoded bitstreams unconditionally. Whether the result is
correct depends entirely on whether the caller (the burn container) got the parameters right
beforehand.

### 4a. Video parameters that must match: resolution, frame rate, pix_fmt, profile, level

**Experiment:** encoded intro slide 0 at 640×360 instead of the master's 1280×720, left slides
1–4 and the master untouched, then ran the identical concat command.

**Result:** `concat exit: 0`. No warning about resolution at all. But:

- `ffprobe` on the resulting file reports the stream as **640×360 for the entire file** — it
  read that from the *first* segment's SPS and never revisits it.
- Decoding actual frames tells a different story: a frame extracted at t=2s (inside the
  mismatched segment) is genuinely 640×360; a frame extracted at t=10s (inside segment 1,
  which was correctly encoded at 1280×720) is genuinely 1280×720.
- `ffmpeg -f null -` (full decode) produced **zero errors or warnings** — `libavcodec`'s H.264
  decoder tolerates an in-stream SPS/resolution change silently and just decodes each part at
  its own size.

**Why this matters for this feature specifically:** the burn container hands the merged file to
Bunny Stream via `fetchVideo()` with a presigned URL. Any downstream consumer that trusts
container-level metadata (width/height reported by a probe, thumbnail generation, a transcoding
ladder decision) rather than re-inspecting every frame would silently use the wrong resolution
for 90%+ of the video. This is exactly the kind of bug that never shows up in local testing
(ffmpeg itself is happy) and only shows up in production dashboards or a broken thumbnail.
**Conclusion: resolution must be probed from the real master and passed explicitly into every
segment encode — never hardcoded, never assumed.** This script already does that; a copy-paste
of a fixed resolution constant into the burn container would be the exact failure mode to avoid.

The same experiment with frame rate (segment 0 encoded at 30fps instead of the master's 25fps)
produced the identical *class* of failure: `concat exit: 0`, ~28 "Non-monotonic DTS" warnings
on the video stream (ffmpeg patching timestamps as it goes), and the output file's
container-level `r_frame_rate` permanently reporting `30/1` for the whole file even though only
the first 5.6s were actually 30fps. Total duration was still correct (the DTS patching keeps
the *timeline* right), but the *declared frame rate* is wrong for the whole asset — again, a
metadata lie that only a real decode-and-measure check would catch.

**Rule:** `pix_fmt`, `profile`, `level`, `codec`, resolution, and frame rate must all be
identical across every segment and the master for the concat's *reported* metadata to be
trustworthy. The demuxer will not refuse a mismatch; it will silently misreport it.

### 4b. Audio parameters that must match: sample rate, channel count/layout

**Experiment:** encoded intro slide 0's silent audio track at 44.1kHz mono instead of the
master's 48kHz stereo.

**Result:** `concat exit: 0` again, but this time the damage was not just metadata — **the
concatenated file's total duration came out as 41.38s instead of the expected 38.0s, a 3.4
second drift.** The mismatched sample rate/channel layout broke the concat demuxer's timestamp
math for the whole file, not just the mismatched segment. This is the one mismatch class that
the (a) duration check in this script's own verification would actually catch (delta of 3.4s is
far outside the ±0.5s tolerance) — so of the three parameter families, an audio-format mismatch
is the "safest" in the sense that it fails loudly on the very first check, rather than passing
silently like the video-metadata cases above.

**Rule:** audio codec, sample rate, and channel count/layout must all match, or the join breaks
audibly and measurably, not just cosmetically.

### 4c. What DOES hold up cleanly: the "everything matched" case

When every segment is encoded with parameters read directly from `ffprobe(master)` — exactly
what `scripts/verify-slide-pipeline.ts` does — the concat:

- Exits 0 with **no errors**.
- Reports (and actually has) identical codec/profile/level/pix_fmt/resolution/frame-rate
  throughout, confirmed both at the container level and by decoding real frames on both sides
  of the join.
- Has the correct total duration to within 21ms over a 38s file (0.06% error, well inside the
  ±0.5s tolerance the spec allows).
- Fully decodes with `ffmpeg -f null -` producing zero error/invalid/corrupt lines.

### 4d. The one residual imperfection, even in the "everything matched" case

Every segment boundary produces one **"Non-monotonic DTS; previous: X, current: Y; changing to
X+1"** warning on the **audio** stream (5 occurrences for 5 intro-segment joins in the canonical
run). Root cause, confirmed by inspecting the raw packet timeline with
`ffprobe -show_entries packet=pts_time`: each segment's AAC stream is encoded independently and
therefore carries its own encoder priming/padding (`initial_padding: 1024` samples, ≈21.3ms at
48kHz — visible in the master's own `ffprobe` output above). When the concat demuxer stitches
two independently-primed AAC streams together, the new segment's first packet timestamp lands
microseconds before where the previous segment's timeline predicted it would, so ffmpeg detects
a (tiny) backward jump and bumps it forward by one tick to keep DTS monotonic.

Concretely, at the boundary between segment 0 and segment 1 (5.6s in), the packet timeline is:

```
... 5.589333  5.610667  5.610688  5.621333  5.642667 ...
```

instead of a perfectly even 21.333ms cadence — one near-duplicate packet (21 *microseconds*
after the previous one, not 21 *milliseconds*) followed by a slightly-short gap before cadence
resumes. This pattern is identical at the seg4→master boundary (the one join where real audio
content, not silence, begins) — so it isn't specific to joining two silent segments.

This is **not** something `-c copy` can fix, because fixing it requires re-encoding audio across
the boundary (trimming exactly the encoder's priming delay), which is the one thing `-c copy` is
explicitly avoiding. It's a fundamental limitation of splicing independently-encoded AAC files at
the container level, not a bug in this pipeline. Given the duplicate is 21 *microseconds* — far
below any threshold of audibility — this is a documented, accepted imperfection, not a blocker.
If genuinely gapless audio ever matters here, the fix is either (a) re-encode audio only during
the final concat (keep `-c:v copy -c:a aac`, i.e. a partial copy), or (b) use a codec without
encoder priming for the silent segments (e.g. PCM), at the cost of a larger intermediate file.

---

## 5. Other findings (not concat-related, found by actually running the pipeline)

### 5a. `page.setContent()` cannot load `file://` images (but CSS `@font-face` works fine)

**Symptom:** the outro slide's logo `<img>` rendered as a broken-image icon in the screenshot,
even though the exact same `file://` URL loaded correctly for the MinionPro `@font-face` fonts
on every other slide.

**Root cause:** `page.setContent()` loads the given HTML into the page at an opaque/blank
navigation context. Chromium's local-resource security policy blocks `<img src="file://...">`
requests from that context ("Not allowed to load local resource"), but does *not* apply the same
restriction to CSS `@font-face src: url("file://...")` — Playwright/Chromium's console reports
the image failure but reports nothing for the font. This asymmetry (same origin restriction
policy, different enforcement per resource type/loading path) is easy to miss because most
slides in the default template are text-only and would never surface it.

**Fix used here:** write each slide's HTML to a real file and navigate with
`page.goto('file://' + htmlPath)` instead of `page.setContent()`. A page loaded via `goto()` has
a genuine `file://` origin and can load sibling `file://` resources (images included). Verified
directly: `naturalWidth`/`naturalHeight` were `0` under `setContent()` and `417`/`413` (the
logo's real dimensions) under `goto()`.

**Relevance beyond this script:** the real burn container will also need to load local image
assets (at minimum the builtin logo, and potentially per-event S3-downloaded images) into the
same headless-Chromium renderer. If its implementation uses `page.setContent()` — a very natural
first choice, since the container already has the rendered HTML string in memory rather than a
file — it will hit this exact bug for every slide with an image line. **This should be flagged
to whoever implements the burn container's rendering step.**

### 5b. `BUILTIN_LOGO_KEY` implies a filename that doesn't exist

`defaults.ts` defines `BUILTIN_LOGO_KEY = "@builtin/padmakara-logo.png"` and
`builtinFilename(BUILTIN_LOGO_KEY)` returns `"padmakara-logo.png"`. No file by that name exists
anywhere in the repository. The actual bundled asset is
`padmakara-app/assets/images/logo.png` (a different filename). A resolver that naively joins a
builtin-assets directory with `builtinFilename(key)` — which is the obvious, documented-looking
way to use that helper — will 404 for the default outro every time.

This script does not use `builtinFilename()` for resolution; it hardcodes the mapping to
`padmakara-app/assets/images/logo.png` (per explicit direction, since `defaults.ts` is out of
scope to modify here). **Whoever wires up the real resolvers (admin preview, burn container)
needs either a file literally renamed/copied to `padmakara-logo.png`, or a resolver that maps
the builtin key to `logo.png` explicitly rather than trusting `builtinFilename()`'s output
verbatim.**

### 5c. The default outro logo is nearly invisible on the mandatory black background

`padmakara-app/assets/images/logo.png` is a dharma-wheel line drawing rendered in near-black
(`~RGB(3,0,1)` to `RGB(5,0,1)`) on a transparent background — 96.5% of its pixels are pure black
`(0,0,0,255)` once composited on the (also mandatory, non-configurable per the design doc)
`#000` slide background, and the remaining ~3.5% are shades of near-black. The measured average
channel brightness of the composited outro frame was **0.04 out of 255**. Visually, the logo is
essentially invisible — a viewer would see a black frame, not a Padmakara logo.

This is presumably a light-background asset (works fine on the app's white UI, or on a
letterhead) being reused somewhere it was never designed for. It is not a pipeline bug — the
renderer faithfully composited exactly what was asked — but as-is, every video that falls back
to the builtin outro (which, per the mid-task change to `buildDefaultOutro()`, is now the
default for *any* event without an explicit logo key) will end on several seconds of what looks
like a plain black screen. **This needs either a white/light variant of the logo for the outro,
or an outro background exception, before this ships.**

---

## 6. Setup notes for reproducing this

- **Playwright:** `padmakara-api` has no Playwright dependency of its own — `@playwright/test`
  (v1.60.0) is a devDependency of `padmakara-app` only, used by its own e2e suite
  (`padmakara-app/e2e/`). This script imports `playwright-core` from
  `padmakara-app/node_modules/playwright-core/index.mjs` via a relative path rather than adding
  a new dependency to `padmakara-api` (out of scope for this task). Bun resolves this fine; the
  machine's shared Chromium cache (`~/Library/Caches/ms-playwright`) is keyed by browser
  revision, not by which `node_modules` requested it.
- **Chromium revision:** this machine's cache had chromium revisions 1161 and 1237 installed
  (presumably from other projects/other Playwright versions used previously), but
  `playwright-core@1.60.0` requires revision **1223**. The first run failed with `Executable
  doesn't exist at .../chromium_headless_shell-1223/...`. Fixed with
  `npx playwright@1.60.0 install chromium` (downloads to the user-level cache, touches no
  project files, ~260MB). A real CI/container environment would need this same install step
  (or a Docker image, as the design doc's runbook presumably covers for the actual burn
  container) — worth calling out since "Playwright is already a dev dependency" does not by
  itself guarantee the matching browser binary is present.
- **ffmpeg/ffprobe:** system-installed at `/opt/homebrew/bin` (Homebrew), version 9.0.1.

## Artifact paths (most recent run)

```
<scratch>/slide-pipeline-verify-1787268681821/
  master.mp4                              — synthetic master
  master.ffprobe.json                     — full ffprobe of the master
  output.ffprobe.json                     — full ffprobe of intro-plus-master.mp4
  intro-plus-master.mp4                   — the primary concat under test (intro + master)
  intro-plus-master-plus-outro.mp4        — bonus full-pipeline concat
  html/intro-{0..4}.html, html/outro-0.html   — rendered slide HTML
  slides-png/intro-{0..4}.png, slides-png/outro-0.png — Chromium screenshots
  segments/intro-{0..4}.mp4, segments/outro-0.mp4     — per-slide encoded segments
  frames/intro-{0..4}-mid.png             — mid-slide frames from the concatenated output
  frames/outro-0-mid.png                  — mid-slide frame from the outro's own segment
  frames/spot-check-intro.png, frames/spot-check-master.png — dimension spot-check frames
```

where `<scratch>` is
`/private/tmp/claude-501/-Users-jeremy-Documents-Programming-padmakara-backend-frontend-padmakara-app/f40fa3bc-f040-4d62-a75d-6830d80f6d92/scratchpad`.

Note this directory is timestamped per run (`slide-pipeline-verify-<Date.now()>`) and lives in
the session scratchpad, not the project tree — re-running `bun run
scripts/verify-slide-pipeline.ts` produces a fresh one alongside it.

---

## Resolutions (applied after this investigation)

Every finding above was acted on. Re-verified by re-running
`padmakara-api/scripts/verify-slide-pipeline.ts` — all checks PASS and the
near-black-outro note no longer fires.

**1. `page.setContent()` blocks `file://` subresources — FIXED, and it was worse than reported.**
`setContent` leaves the document's base URL as `about:blank`, and Chromium refuses to load
`file://` subresources from such a document. That blocked not only image lines but **the four
MinionPro `@font-face` files**, so every burned slide would have rendered in a fallback serif
with no logo — permanently, in the video. `document.fonts.ready` does not catch it either: it
resolves once loading settles, failures included. The container now writes each slide's HTML
to the work directory and navigates to it with `page.goto("file://…")`.

**2. Concat parameter mismatches pass the duration gate — FIXED.**
Since the concat demuxer does not validate that its inputs share parameters, a resolution or
frame-rate mismatch exits 0 and writes a file whose metadata describes only the first segment,
while the duration still looks correct. `findConcatParamMismatches()` was added to
`ffmpeg-plan.ts` as a second, independent gate covering resolution, video codec, pixel format,
audio codec, sample rate and channel count. Failing either gate triggers the re-encode
fallback; failing either gate *after* the fallback now throws.

**3. The bundled logo filename — NOT a defect.**
`BUILTIN_LOGO_KEY` resolves to `padmakara-logo.png`, and both consumers ship exactly that
filename (`containers/video-burn/assets/`, `admin/public/images/`). The source asset in
`padmakara-app` is named `logo.png` and is renamed on copy. Nothing to fix.

**4. The logo is ~96.5% black pixels — FIXED. This was the most valuable finding here.**
The Padmakara Dharma wheel is black line art on transparency. Composited onto the mandatory
black slide background it was very nearly invisible, so the outro would have shipped
effectively blank. The two *bundled* copies are now RGB-negated (alpha preserved), giving
white line art on transparency. The app's own `logo.png` is deliberately untouched — it is
used elsewhere against light backgrounds.

Note that this script previously resolved the builtin key to the app's `logo.png`, meaning it
verified the wrong file. It now resolves to `containers/video-burn/assets/`, exactly as the
burn container does, so what it checks is what actually ships.
