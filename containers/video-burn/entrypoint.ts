/**
 * Video title-slide burn-in — AWS Batch container entrypoint.
 *
 * Pipeline (see docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md):
 *   1. Download the master recording from S3.
 *   2. ffprobe it to learn the master's exact codec parameters.
 *   3. Download the slide document + any image-line assets it references.
 *   4. Render each slide to HTML (shared renderer) and screenshot it with
 *      headless Chromium at the master's real resolution.
 *   5. Encode each slide PNG to a video segment matching the master's
 *      params exactly, with fade in/out and a silent audio track.
 *   6. Concat intro segments + master + outro segments (stream copy first,
 *      full re-encode fallback if duration validation fails).
 *   7. Upload the merged file to S3, presign a GET, hand it to Bunny's
 *      fetch endpoint.
 *   8. Extract a poster frame from the MASTER (not the merged file — that
 *      starts with the burned-in intro) and set it as the video's Bunny
 *      thumbnail, so the app's video grid never shows a black poster.
 *   9. POST the completion (or failure) webhook.
 *
 * Run with `npx tsx entrypoint.ts` (see package.json / Dockerfile) — no
 * separate build step.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

import { renderSlideHtml } from "../../src/lib/slides/render.ts";
import { isBuiltinKey, builtinFilename } from "../../src/lib/slides/defaults.ts";
import type { Slide, SlideDocument, ImageLine } from "../../src/lib/slides/types.ts";
import {
  parseFfprobeOutput,
  buildSlideSegmentArgs,
  buildConcatArgs,
  buildConcatListFile,
  computeBurnDurationPlan,
  findConcatParamMismatches,
  isDurationWithinTolerance,
  computeThumbnailOffsetSeconds,
  buildThumbnailFrameArgs,
  type MasterParams,
} from "./ffmpeg-plan.ts";
import { makeS3Client, downloadToFile, downloadText, uploadFile, presignGet } from "./s3-client.ts";
import { fetchVideo, setThumbnail, type BunnyConfig } from "./bunny-client.ts";
import { postWebhook } from "./webhook.ts";
import { resolveMasterSource, type MasterSource } from "./source.ts";

const execFileAsync = promisify(execFile);

// ─── Env ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface JobEnv {
  jobId: string;
  videoId: number;
  source: MasterSource;
  slidesS3Key: string;
  outputS3Key: string;
  bucket: string;
  title: string;
  webhookUrl: string;
  webhookSecret: string;
  storage: { endpoint: string; accessKeyId: string; secretAccessKey: string; region: string };
  bunny: BunnyConfig;
}

function readJobEnv(): JobEnv {
  return {
    jobId: requireEnv("JOB_ID"),
    videoId: Number(requireEnv("VIDEO_ID")),
    source: resolveMasterSource(process.env),
    slidesS3Key: requireEnv("SLIDES_S3_KEY"),
    outputS3Key: requireEnv("OUTPUT_S3_KEY"),
    bucket: requireEnv("S3_BUCKET"),
    title: process.env.TITLE ?? "",
    webhookUrl: requireEnv("WEBHOOK_URL"),
    webhookSecret: requireEnv("WEBHOOK_SECRET"),
    storage: {
      endpoint: process.env.S3_ENDPOINT ?? "",
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      region: process.env.S3_REGION ?? "eu-west-3",
    },
    // Static per-job-definition secrets, NOT part of containerOverrides
    // (see docs/runbooks/video-burn-provisioning.md) — every job needs the
    // same Bunny library credentials, so they're set once on the job
    // definition rather than repeated in every SubmitJobCommand call.
    bunny: {
      libraryId: requireEnv("BUNNY_STREAM_LIBRARY_ID"),
      apiKey: requireEnv("BUNNY_STREAM_API_KEY"),
    },
  };
}

// ─── ffmpeg/ffprobe process helpers ─────────────────────────────────────

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    maxBuffer: 1024 * 1024 * 64,
  });
}

async function probeFile(filePath: string): Promise<MasterParams> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 1024 * 1024 * 64 },
  );
  return parseFfprobeOutput(JSON.parse(stdout));
}

// ─── URL master source (MASTER_SOURCE_URL) ──────────────────────────────

/** Streams a URL straight to disk — used for the MASTER_SOURCE_URL path
 *  (the container downloads the master itself, rather than the browser
 *  having already PUT it to S3). Not unit tested: it's network I/O, same
 *  as downloadToFile/uploadFile in s3-client.ts — only resolveMasterSource
 *  (source.ts) is pure enough to test without a real fetch. */
async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download master from URL: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
}

/** File extension for the retained-original upload key, from the URL's own
 *  path when it has one, falling back to .mp4 (matches the S3-upload
 *  path's own master.mp4 naming). */
function extFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname);
    return ext || ".mp4";
  } catch {
    return ".mp4";
  }
}

// ─── Slide rendering (Chromium) ─────────────────────────────────────────

const FONTS_DIR = path.resolve(import.meta.dirname, "fonts");
const ASSETS_DIR = path.resolve(import.meta.dirname, "assets");

/**
 * Resolve a slide image line's s3Key to a file:// URL Chromium can load.
 * Builtin keys (the bundled Padmakara outro logo, @builtin/...) resolve to
 * the image shipped in the container image; everything else resolves to a
 * previously-downloaded local copy (see downloadImageAssets below).
 */
function makeResolveImageUrl(downloaded: Map<string, string>): (s3Key: string) => string {
  return (s3Key: string) => {
    if (isBuiltinKey(s3Key)) {
      const filename = builtinFilename(s3Key);
      const localPath = path.join(ASSETS_DIR, filename);
      if (!existsSync(localPath)) {
        // A silently broken image box in a burned, effectively-permanent
        // video is much worse than a failed job — fail loudly and early.
        throw new Error(
          `Builtin slide asset "${filename}" (from key "${s3Key}") is not bundled in the container image at ${localPath}`,
        );
      }
      return `file://${localPath}`;
    }
    const localPath = downloaded.get(s3Key);
    if (!localPath) {
      throw new Error(`Slide image "${s3Key}" was not pre-downloaded`);
    }
    return `file://${localPath}`;
  };
}

function collectImageLines(doc: SlideDocument): ImageLine[] {
  const lines: ImageLine[] = [];
  for (const slide of [...doc.intro, ...doc.outro]) {
    for (const line of slide.lines) {
      if (line.type === "image") lines.push(line);
    }
  }
  return lines;
}

async function downloadImageAssets(
  client: ReturnType<typeof makeS3Client>,
  bucket: string,
  doc: SlideDocument,
  workDir: string,
): Promise<Map<string, string>> {
  const downloaded = new Map<string, string>();
  const imageLines = collectImageLines(doc);
  let i = 0;
  for (const line of imageLines) {
    // Builtin assets ship in the image — fetching "@builtin/..." from S3
    // would just 404 and fail the job for no reason.
    if (isBuiltinKey(line.s3Key)) continue;
    if (downloaded.has(line.s3Key)) continue;
    const ext = path.extname(line.s3Key) || ".png";
    const destPath = path.join(workDir, `image-${i++}${ext}`);
    await downloadToFile(client, bucket, line.s3Key, destPath);
    downloaded.set(line.s3Key, destPath);
  }
  return downloaded;
}

interface RenderedSlide {
  slide: Slide;
  pngPath: string;
}

async function renderSlides(
  slides: Slide[],
  params: MasterParams,
  resolveImageUrl: (s3Key: string) => string,
  workDir: string,
  prefix: string,
): Promise<RenderedSlide[]> {
  if (slides.length === 0) return [];

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: params.width, height: params.height } });
    const rendered: RenderedSlide[] = [];
    let i = 0;
    for (const slide of slides) {
      const html = renderSlideHtml(slide, {
        width: params.width,
        height: params.height,
        fontBaseUrl: `file://${FONTS_DIR}/`,
        resolveImageUrl,
      });
      // Write the HTML to disk and navigate to it, rather than page.setContent().
      // setContent leaves the document's base URL as about:blank, and Chromium
      // refuses to load file:// subresources from an about:blank document — so
      // BOTH the MinionPro @font-face files and any file:// image (the outro
      // logo especially) fail silently, yielding a fallback serif and a missing
      // logo burned permanently into the video. document.fonts.ready does not
      // catch it either: it resolves once loading settles, failures included.
      const htmlPath = path.join(workDir, `${prefix}-slide-${i}.html`);
      await writeFile(htmlPath, html, "utf-8");
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      // Belt-and-braces on top of networkidle: makes sure the @font-face
      // faces have actually finished rasterising before the screenshot.
      // This callback runs inside the PAGE (browser context), not Node —
      // `document` here is the DOM global, which is why this file's own
      // tsconfig opts into the "DOM" lib (see containers/video-burn/tsconfig.json).
      await page.evaluate(() => document.fonts.ready);

      const pngPath = path.join(workDir, `${prefix}-slide-${i++}.png`);
      await page.screenshot({ path: pngPath, type: "png" });
      rendered.push({ slide, pngPath });
    }
    return rendered;
  } finally {
    await browser.close();
  }
}

// ─── Segment encoding + concat ──────────────────────────────────────────

async function encodeSegments(rendered: RenderedSlide[], params: MasterParams, workDir: string, prefix: string): Promise<string[]> {
  const segmentPaths: string[] = [];
  let i = 0;
  for (const { slide, pngPath } of rendered) {
    const outputPath = path.join(workDir, `${prefix}-seg-${i++}.mp4`);
    const args = buildSlideSegmentArgs({
      imagePath: pngPath,
      outputPath,
      params,
      fadeInMs: slide.fadeMs,
      holdMs: slide.durationMs,
      fadeOutMs: slide.fadeMs,
    });
    await runFfmpeg(args);
    segmentPaths.push(outputPath);
  }
  return segmentPaths;
}

async function concatAndValidate(
  segmentPaths: string[],
  expectedTotalMs: number,
  params: MasterParams,
  workDir: string,
): Promise<string> {
  const listPath = path.join(workDir, "concat-list.txt");
  await writeFile(listPath, buildConcatListFile(segmentPaths), "utf-8");

  const mergedPath = path.join(workDir, "merged.mp4");

  await runFfmpeg(buildConcatArgs({ fileListPath: listPath, outputPath: mergedPath, reencode: false }));
  let outParams = await probeFile(mergedPath);
  let actualMs = outParams.durationSeconds * 1000;

  // Two independent gates. Duration alone would miss a parameter mismatch: the
  // concat demuxer accepts mismatched segments silently and writes a file whose
  // metadata describes only the first one, while the duration still looks right.
  let durationOk = isDurationWithinTolerance(actualMs, expectedTotalMs);
  let mismatches = findConcatParamMismatches(outParams, params);

  if (!durationOk || mismatches.length > 0) {
    const why = !durationOk
      ? `expected ~${expectedTotalMs}ms, got ${actualMs}ms`
      : `parameter mismatch: ${mismatches.join("; ")}`;
    console.error(
      `[video-burn] FALLBACK: stream-copy concat validation failed (${why}) — ` +
        `retrying with a full re-encode.`,
    );
    await runFfmpeg(
      buildConcatArgs({ fileListPath: listPath, outputPath: mergedPath, reencode: true, params }),
    );
    outParams = await probeFile(mergedPath);
    actualMs = outParams.durationSeconds * 1000;
    durationOk = isDurationWithinTolerance(actualMs, expectedTotalMs);
    mismatches = findConcatParamMismatches(outParams, params);
    if (!durationOk) {
      throw new Error(
        `Concat duration validation failed even after full re-encode ` +
          `(expected ~${expectedTotalMs}ms, got ${actualMs}ms)`,
      );
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Concat parameter validation failed even after full re-encode: ${mismatches.join("; ")}`,
      );
    }
    console.error("[video-burn] Full re-encode fallback succeeded and passed validation.");
  }

  return mergedPath;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = readJobEnv();
  const s3 = makeS3Client({ ...env.storage, bucket: env.bucket });

  const workDir = await mkdtemp(path.join(tmpdir(), "video-burn-"));
  let warning: string | undefined;

  try {
    // 1–2. Master + ffprobe
    const masterPath = path.join(workDir, "master.mp4");
    let masterS3Key: string;
    if (env.source.kind === "s3Key") {
      await downloadToFile(s3, env.bucket, env.source.key, masterPath);
      masterS3Key = env.source.key;
    } else {
      // MASTER_SOURCE_URL: the container downloads the file itself, then
      // retains the untouched original in S3 BEFORE burning — so a later
      // slide edit re-burns from a first-generation master, same guarantee
      // the MASTER_S3_KEY (browser-upload) path already has from the start.
      await downloadUrlToFile(env.source.url, masterPath);
      masterS3Key = `video-burn/${env.videoId}/master${extFromUrl(env.source.url)}`;
      await uploadFile(s3, env.bucket, masterS3Key, masterPath, "video/mp4");
    }
    const params = await probeFile(masterPath);

    // 3. Slide document + assets
    const slidesJson = await downloadText(s3, env.bucket, env.slidesS3Key);
    const doc = JSON.parse(slidesJson) as SlideDocument;
    const downloadedImages = await downloadImageAssets(s3, env.bucket, doc, workDir);
    const resolveImageUrl = makeResolveImageUrl(downloadedImages);

    // 4–5. Render + encode intro/outro segments
    const introRendered = await renderSlides(doc.intro, params, resolveImageUrl, workDir, "intro");
    const outroRendered = await renderSlides(doc.outro, params, resolveImageUrl, workDir, "outro");
    const introSegments = await encodeSegments(introRendered, params, workDir, "intro");
    const outroSegments = await encodeSegments(outroRendered, params, workDir, "outro");

    // 6. Concat (+ validate, with re-encode fallback)
    const plan = computeBurnDurationPlan(doc.intro, doc.outro, params.durationSeconds * 1000);
    const mergedPath = await concatAndValidate(
      [...introSegments, masterPath, ...outroSegments],
      plan.totalMs,
      params,
      workDir,
    );

    // 7. Upload merged file, hand to Bunny
    await uploadFile(s3, env.bucket, env.outputS3Key, mergedPath, "video/mp4");
    // 6h TTL — mirrors the presign TTL used for the same "presign an S3
    // object, hand it to Bunny fetchVideo()" shape in
    // src/scripts/import-s3-videos.ts; Bunny's async fetch can take a while
    // for a large merged file.
    const mergedUrl = await presignGet(s3, env.bucket, env.outputS3Key, 6 * 60 * 60);
    const { guid } = await fetchVideo(env.bunny, mergedUrl, env.title || `video-${env.videoId}`);

    // 8. Poster thumbnail from the MASTER (never from the merged file —
    // that starts with the burned-in intro, which is exactly the black
    // card we're trying to avoid as a poster). Best-effort: a failure here
    // must not fail an otherwise-successful burn.
    try {
      const offsetSeconds = computeThumbnailOffsetSeconds(params.durationSeconds);
      const thumbPath = path.join(workDir, "thumbnail.jpg");
      await runFfmpeg(buildThumbnailFrameArgs(masterPath, offsetSeconds, thumbPath));
      const thumbKey = `video-burn/${env.videoId}/thumbnail.jpg`;
      await uploadFile(s3, env.bucket, thumbKey, thumbPath, "image/jpeg");
      const thumbUrl = await presignGet(s3, env.bucket, thumbKey, 60 * 60);
      await setThumbnail(env.bunny, guid, thumbUrl);
    } catch (err) {
      warning = `Thumbnail extraction/upload failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[video-burn] ${warning} — continuing, merged video is still good.`);
    }

    // 9. Success webhook
    await postWebhook(env.webhookUrl, env.webhookSecret, {
      jobId: env.jobId,
      videoId: env.videoId,
      status: "completed",
      bunnyVideoId: guid,
      introMs: plan.introMs,
      outroMs: plan.outroMs,
      masterS3Key,
      warning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[video-burn] Job failed:", err);
    await postWebhook(env.webhookUrl, env.webhookSecret, {
      jobId: env.jobId,
      videoId: env.videoId,
      status: "failed",
      error: message,
    });
    process.exitCode = 1;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// main() is orchestration-only (spawns ffmpeg/ffprobe, drives Chromium,
// talks to S3/Bunny) and is deliberately NOT unit tested directly — the
// pure logic it calls into (ffmpeg-plan.ts) is what's tested, from the
// backend's tests/services/video-burn.test.ts.
main();
