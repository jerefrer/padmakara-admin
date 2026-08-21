/**
 * Pure planning logic for the burn container: ffmpeg/ffprobe argument
 * construction and slide-segment timing maths. Deliberately free of any
 * Node.js I/O (no fs, no child_process) so it can be:
 *   - imported by entrypoint.ts to build the actual commands it spawns, and
 *   - unit-tested directly from the backend's Vitest suite
 *     (tests/services/video-burn.test.ts) without mocking a filesystem or
 *     spawning real ffmpeg processes.
 *
 * Imports the shared slide types/timing helpers from the backend's
 * src/lib/slides/types.ts — those are equally pure, so re-using them here
 * keeps the burn container's timing maths bit-for-bit identical to what the
 * admin preview (and the design doc) describe, rather than a hand-rolled
 * second implementation that could drift.
 */

import { sequenceTotalMs, type Slide } from "../../src/lib/slides/types.ts";

// ─── ffprobe → MasterParams ─────────────────────────────────────────────

export interface MasterParams {
  width: number;
  height: number;
  /** ffmpeg -r / fps filter value, taken verbatim from ffprobe's r_frame_rate, e.g. "30000/1001". */
  fps: string;
  pixelFormat: string;
  /** ffprobe's codec_name (a DEcoder name, e.g. "h264") — see videoEncoderFor() for the matching encoder. */
  videoCodec: string;
  videoProfile?: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  durationSeconds: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** Parse `ffprobe -print_format json -show_format -show_streams` output. */
export function parseFfprobeOutput(raw: unknown): MasterParams {
  const data = (raw ?? {}) as FfprobeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) {
    throw new Error("ffprobe output has no video stream");
  }

  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: video.r_frame_rate ?? "25/1",
    pixelFormat: video.pix_fmt ?? "yuv420p",
    videoCodec: video.codec_name ?? "h264",
    videoProfile: video.profile,
    // No audio stream is unusual but not fatal for a title-slide pipeline —
    // fall back to sane defaults so a silent master still produces silent,
    // correctly-shaped slide segments instead of throwing.
    audioCodec: audio?.codec_name ?? "aac",
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : 48000,
    audioChannels: audio?.channels ?? 2,
    durationSeconds: Number(data.format?.duration ?? "0") || 0,
  };
}

// ffprobe reports DEcoder names; ffmpeg's `-c:v`/`-c:a` want an ENcoder
// name, which for several common codecs differs (h264 → libx264, etc).
// Unrecognised codecs fall back to the raw name — better to let ffmpeg
// itself reject an unsupported encoder with a clear error than to silently
// substitute something wrong.
const VIDEO_ENCODER_MAP: Record<string, string> = {
  h264: "libx264",
  hevc: "libx265",
  vp9: "libvpx-vp9",
  vp8: "libvpx",
  mpeg4: "mpeg4",
  mpeg2video: "mpeg2video",
};

const AUDIO_ENCODER_MAP: Record<string, string> = {
  aac: "aac",
  mp3: "libmp3lame",
  ac3: "ac3",
  opus: "libopus",
  vorbis: "libvorbis",
  pcm_s16le: "pcm_s16le",
};

export function videoEncoderFor(codecName: string): string {
  return VIDEO_ENCODER_MAP[codecName] ?? codecName;
}

export function audioEncoderFor(codecName: string): string {
  return AUDIO_ENCODER_MAP[codecName] ?? codecName;
}

// ─── Slide PNG → video segment ──────────────────────────────────────────

export interface SlideSegmentSpec {
  imagePath: string;
  outputPath: string;
  params: MasterParams;
  fadeInMs: number;
  holdMs: number;
  fadeOutMs: number;
}

/**
 * Build the ffmpeg args that turn one rendered slide PNG into a video
 * segment matching the master's exact codec parameters, with a fade in
 * from black, a hold, a fade out to black, and a SILENT audio track
 * matching the master's audio params (so the eventual concat has matching
 * streams on every segment).
 */
export function buildSlideSegmentArgs(spec: SlideSegmentSpec): string[] {
  const { imagePath, outputPath, params, fadeInMs, holdMs, fadeOutMs } = spec;
  const totalSeconds = (fadeInMs + holdMs + fadeOutMs) / 1000;
  const fadeInSeconds = fadeInMs / 1000;
  const fadeOutStartSeconds = (fadeInMs + holdMs) / 1000;
  const fadeOutSeconds = fadeOutMs / 1000;

  const videoFilterParts = [`fps=${params.fps}`, `format=${params.pixelFormat}`];
  if (fadeInMs > 0) videoFilterParts.push(`fade=t=in:st=0:d=${fadeInSeconds}`);
  if (fadeOutMs > 0) videoFilterParts.push(`fade=t=out:st=${fadeOutStartSeconds}:d=${fadeOutSeconds}`);

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=${params.audioChannels === 1 ? "mono" : "stereo"}:sample_rate=${params.audioSampleRate}`,
    "-t",
    totalSeconds.toFixed(3),
    "-vf",
    videoFilterParts.join(","),
    "-s",
    `${params.width}x${params.height}`,
    "-c:v",
    videoEncoderFor(params.videoCodec),
    "-pix_fmt",
    params.pixelFormat,
  ];

  if (params.videoProfile) {
    args.push("-profile:v", params.videoProfile.toLowerCase());
  }

  args.push(
    "-c:a",
    audioEncoderFor(params.audioCodec),
    "-ar",
    String(params.audioSampleRate),
    "-ac",
    String(params.audioChannels),
    // Segment length is fixed by -t above; -shortest guards against
    // anullsrc (which is infinite) ever driving the output length instead.
    "-shortest",
    outputPath,
  );

  return args;
}

// ─── Concat ──────────────────────────────────────────────────────────────

export interface ConcatSpec {
  /** Path to the ffmpeg concat-demuxer list file (`file '...'` per line). */
  fileListPath: string;
  outputPath: string;
  /** false = stream copy (`-c copy`, fast); true = full re-encode fallback. */
  reencode: boolean;
  /** Required when reencode is true. */
  params?: MasterParams;
}

export function buildConcatArgs(spec: ConcatSpec): string[] {
  const base = ["-y", "-f", "concat", "-safe", "0", "-i", spec.fileListPath];

  if (!spec.reencode) {
    return [...base, "-c", "copy", spec.outputPath];
  }

  if (!spec.params) {
    throw new Error("buildConcatArgs: params is required when reencode is true");
  }
  const { params } = spec;
  return [
    ...base,
    "-c:v",
    videoEncoderFor(params.videoCodec),
    "-pix_fmt",
    params.pixelFormat,
    "-c:a",
    audioEncoderFor(params.audioCodec),
    "-ar",
    String(params.audioSampleRate),
    "-ac",
    String(params.audioChannels),
    spec.outputPath,
  ];
}

/**
 * One line of an ffmpeg concat-demuxer list file. Single quotes in the path
 * are escaped per ffmpeg's documented convention (close the quote, emit an
 * escaped quote, reopen) — concat list paths are always single-quoted.
 */
export function concatListLine(absolutePath: string): string {
  const escaped = absolutePath.replace(/'/g, "'\\''");
  return `file '${escaped}'`;
}

export function buildConcatListFile(absolutePaths: string[]): string {
  return absolutePaths.map(concatListLine).join("\n") + "\n";
}

// ─── Timing maths ────────────────────────────────────────────────────────

export interface BurnDurationPlan {
  introMs: number;
  outroMs: number;
  masterMs: number;
  totalMs: number;
}

/** Expected total duration of the merged output, from the slide document and the master's own duration. */
export function computeBurnDurationPlan(
  introSlides: Slide[],
  outroSlides: Slide[],
  masterDurationMs: number,
): BurnDurationPlan {
  const introMs = sequenceTotalMs(introSlides);
  const outroMs = sequenceTotalMs(outroSlides);
  return { introMs, outroMs, masterMs: masterDurationMs, totalMs: introMs + masterDurationMs + outroMs };
}

const DEFAULT_DURATION_TOLERANCE_MS = 500;

/** Validation gate for the concat output: actual vs. expected duration, ±0.5s by default (per the design doc). */
export function isDurationWithinTolerance(
  actualMs: number,
  expectedMs: number,
  toleranceMs: number = DEFAULT_DURATION_TOLERANCE_MS,
): boolean {
  return Math.abs(actualMs - expectedMs) <= toleranceMs;
}

/**
 * Second validation gate for the concat output: does the merged file still
 * carry the master's video parameters?
 *
 * The duration check alone is NOT sufficient. The concat demuxer does not
 * verify that its inputs share parameters — given a segment whose resolution
 * or frame rate differs from the master's, ffmpeg exits 0 with no warning and
 * writes a file whose container metadata describes only the FIRST segment.
 * The result decodes, reports a plausible duration, and would be ingested by
 * Bunny with dimensions that do not match its own content. This was verified
 * empirically by deliberately mismatching each parameter in turn — see
 * docs/superpowers/notes/2026-08-21-slide-pipeline-verification.md.
 *
 * Returns the list of mismatches, empty when the output is faithful.
 */
export function findConcatParamMismatches(
  actual: MasterParams,
  expected: MasterParams,
): string[] {
  const mismatches: string[] = [];
  if (actual.width !== expected.width || actual.height !== expected.height) {
    mismatches.push(
      `resolution ${actual.width}x${actual.height} != master ${expected.width}x${expected.height}`,
    );
  }
  if (actual.videoCodec !== expected.videoCodec) {
    mismatches.push(`video codec ${actual.videoCodec} != master ${expected.videoCodec}`);
  }
  if (actual.pixelFormat !== expected.pixelFormat) {
    mismatches.push(`pixel format ${actual.pixelFormat} != master ${expected.pixelFormat}`);
  }
  if (actual.audioCodec !== expected.audioCodec) {
    mismatches.push(`audio codec ${actual.audioCodec} != master ${expected.audioCodec}`);
  }
  if (actual.audioSampleRate !== expected.audioSampleRate) {
    mismatches.push(
      `audio sample rate ${actual.audioSampleRate} != master ${expected.audioSampleRate}`,
    );
  }
  if (actual.audioChannels !== expected.audioChannels) {
    mismatches.push(`audio channels ${actual.audioChannels} != master ${expected.audioChannels}`);
  }
  return mismatches;
}

// ─── Thumbnail frame offset ──────────────────────────────────────────────

const THUMBNAIL_OFFSET_FRACTION = 0.1;
const THUMBNAIL_MIN_OFFSET_SECONDS = 3;
// Leave a small margin off the very end so a seek can never land at/after EOF.
const THUMBNAIL_END_MARGIN_SECONDS = 0.5;

/**
 * Pick a timestamp into the MASTER (not the merged output — the merged
 * output starts with the burned-in intro, which is exactly what we're
 * trying to avoid thumbnailing) to grab a representative poster frame
 * from. 10% into the recording reliably lands on real content; a fixed
 * few seconds is often still silence, a black slate, or a fade-up at the
 * start of a raw retreat recording. Clamped to at least 3s so very short
 * masters don't sample frame zero, and clamped below the master's own
 * duration so ffmpeg never seeks past EOF.
 */
export function computeThumbnailOffsetSeconds(masterDurationSeconds: number): number {
  if (masterDurationSeconds <= 0) return 0;
  const target = Math.max(masterDurationSeconds * THUMBNAIL_OFFSET_FRACTION, THUMBNAIL_MIN_OFFSET_SECONDS);
  const maxSeekable = Math.max(0, masterDurationSeconds - THUMBNAIL_END_MARGIN_SECONDS);
  return Math.min(target, maxSeekable);
}

/** ffmpeg args to grab a single JPEG frame at `offsetSeconds` into `inputPath`. */
export function buildThumbnailFrameArgs(inputPath: string, offsetSeconds: number, outputPath: string): string[] {
  return [
    "-y",
    // -ss before -i is the fast-seek path (keyframe-nearest via demuxer),
    // which is what we want for a cheap poster-frame grab.
    "-ss",
    offsetSeconds.toFixed(3),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ];
}
