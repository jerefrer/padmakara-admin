import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── containers/video-burn/ffmpeg-plan.ts — pure functions ──────────────
// Imported directly (not mocked) — this is the whole point: the container's
// arg-building and timing maths are tested without spawning ffmpeg/Chromium
// or touching the filesystem.

import {
  parseFfprobeOutput,
  videoEncoderFor,
  audioEncoderFor,
  buildSlideSegmentArgs,
  buildConcatArgs,
  concatListLine,
  buildConcatListFile,
  computeBurnDurationPlan,
  isDurationWithinTolerance,
  findConcatParamMismatches,
  computeThumbnailOffsetSeconds,
  buildThumbnailFrameArgs,
  type MasterParams,
} from "../../containers/video-burn/ffmpeg-plan.ts";
import type { Slide } from "../../src/lib/slides/types.ts";

function slide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: "s1",
    durationMs: 4000,
    fadeMs: 800,
    lines: [],
    ...overrides,
  };
}

const PARAMS: MasterParams = {
  width: 1920,
  height: 1080,
  fps: "30000/1001",
  pixelFormat: "yuv420p",
  videoCodec: "h264",
  videoProfile: "High",
  audioCodec: "aac",
  audioSampleRate: 48000,
  audioChannels: 2,
  durationSeconds: 3600,
};

/** Finds `--flag value` in an ffmpeg arg array and returns `value`. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("ffmpeg-plan: parseFfprobeOutput", () => {
  it("extracts video + audio stream params and duration", () => {
    const params = parseFfprobeOutput({
      format: { duration: "125.5" },
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          profile: "High",
          width: 1920,
          height: 1080,
          r_frame_rate: "30000/1001",
          pix_fmt: "yuv420p",
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
        },
      ],
    });

    expect(params).toEqual({
      width: 1920,
      height: 1080,
      fps: "30000/1001",
      pixelFormat: "yuv420p",
      videoCodec: "h264",
      videoProfile: "High",
      audioCodec: "aac",
      audioSampleRate: 48000,
      audioChannels: 2,
      durationSeconds: 125.5,
    });
  });

  it("throws when there is no video stream", () => {
    expect(() => parseFfprobeOutput({ streams: [{ codec_type: "audio" }] })).toThrow(
      /no video stream/,
    );
  });

  it("falls back to sane audio defaults when there is no audio stream", () => {
    const params = parseFfprobeOutput({
      format: { duration: "10" },
      streams: [{ codec_type: "video", width: 640, height: 360 }],
    });
    expect(params.audioCodec).toBe("aac");
    expect(params.audioSampleRate).toBe(48000);
    expect(params.audioChannels).toBe(2);
  });
});

describe("ffmpeg-plan: codec name mapping", () => {
  it("maps known decoder names to their ffmpeg encoder", () => {
    expect(videoEncoderFor("h264")).toBe("libx264");
    expect(videoEncoderFor("hevc")).toBe("libx265");
    expect(audioEncoderFor("aac")).toBe("aac");
    expect(audioEncoderFor("mp3")).toBe("libmp3lame");
  });

  it("falls back to the raw codec name when unrecognised", () => {
    expect(videoEncoderFor("some-future-codec")).toBe("some-future-codec");
    expect(audioEncoderFor("some-future-codec")).toBe("some-future-codec");
  });
});

describe("ffmpeg-plan: buildSlideSegmentArgs", () => {
  it("builds args matching the master's params, with a silent stereo track and fades", () => {
    const args = buildSlideSegmentArgs({
      imagePath: "/tmp/slide-0.png",
      outputPath: "/tmp/seg-0.mp4",
      params: PARAMS,
      fadeInMs: 800,
      holdMs: 4000,
      fadeOutMs: 800,
    });

    expect(flagValue(args, "-i")).toBe("/tmp/slide-0.png");
    expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    expect(flagValue(args, "-t")).toBe("5.600"); // (800+4000+800)/1000
    expect(flagValue(args, "-s")).toBe("1920x1080");
    expect(flagValue(args, "-c:v")).toBe("libx264");
    expect(flagValue(args, "-pix_fmt")).toBe("yuv420p");
    expect(flagValue(args, "-profile:v")).toBe("high");
    expect(flagValue(args, "-c:a")).toBe("aac");
    expect(flagValue(args, "-ar")).toBe("48000");
    expect(flagValue(args, "-ac")).toBe("2");
    expect(args).toContain("-shortest");
    expect(args.at(-1)).toBe("/tmp/seg-0.mp4");

    const vf = flagValue(args, "-vf")!;
    expect(vf).toContain("fade=t=in:st=0:d=0.8");
    expect(vf).toContain("fade=t=out:st=4.8:d=0.8"); // fadeOut starts at (fadeIn+hold)/1000
  });

  it("uses a mono anullsrc when the master is mono", () => {
    const args = buildSlideSegmentArgs({
      imagePath: "/tmp/s.png",
      outputPath: "/tmp/o.mp4",
      params: { ...PARAMS, audioChannels: 1 },
      fadeInMs: 500,
      holdMs: 1000,
      fadeOutMs: 500,
    });
    expect(args).toContain("anullsrc=channel_layout=mono:sample_rate=48000");
  });

  it("omits fade filters entirely when fadeMs is 0", () => {
    const args = buildSlideSegmentArgs({
      imagePath: "/tmp/s.png",
      outputPath: "/tmp/o.mp4",
      params: PARAMS,
      fadeInMs: 0,
      holdMs: 2000,
      fadeOutMs: 0,
    });
    const vf = flagValue(args, "-vf")!;
    expect(vf).not.toContain("fade=");
  });

  it("omits -profile:v when the master has no reported profile", () => {
    const args = buildSlideSegmentArgs({
      imagePath: "/tmp/s.png",
      outputPath: "/tmp/o.mp4",
      params: { ...PARAMS, videoProfile: undefined },
      fadeInMs: 100,
      holdMs: 100,
      fadeOutMs: 100,
    });
    expect(args).not.toContain("-profile:v");
  });
});

describe("ffmpeg-plan: buildConcatArgs", () => {
  it("builds a stream-copy concat command by default", () => {
    const args = buildConcatArgs({
      fileListPath: "/tmp/list.txt",
      outputPath: "/tmp/merged.mp4",
      reencode: false,
    });
    expect(args).toEqual([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "/tmp/list.txt",
      "-c",
      "copy",
      "/tmp/merged.mp4",
    ]);
  });

  it("builds a full re-encode command matching the master's params", () => {
    const args = buildConcatArgs({
      fileListPath: "/tmp/list.txt",
      outputPath: "/tmp/merged.mp4",
      reencode: true,
      params: PARAMS,
    });
    expect(flagValue(args, "-c:v")).toBe("libx264");
    expect(flagValue(args, "-pix_fmt")).toBe("yuv420p");
    expect(flagValue(args, "-c:a")).toBe("aac");
    expect(flagValue(args, "-ar")).toBe("48000");
    expect(flagValue(args, "-ac")).toBe("2");
    expect(args).not.toContain("-c"); // no bare "-c copy" mixed in
    expect(args.at(-1)).toBe("/tmp/merged.mp4");
  });

  it("throws when reencode is true but params are missing", () => {
    expect(() =>
      buildConcatArgs({ fileListPath: "/tmp/l.txt", outputPath: "/tmp/o.mp4", reencode: true }),
    ).toThrow(/params is required/);
  });
});

describe("ffmpeg-plan: concat list file", () => {
  it("formats one `file '...'` line per path", () => {
    const out = buildConcatListFile(["/tmp/a.mp4", "/tmp/b.mp4"]);
    expect(out).toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n");
  });

  it("escapes single quotes in a path per ffmpeg's convention", () => {
    expect(concatListLine("/tmp/o'brien.mp4")).toBe("file '/tmp/o'\\''brien.mp4'");
  });
});

describe("ffmpeg-plan: computeBurnDurationPlan", () => {
  it("sums intro + outro slide totals with the master's duration", () => {
    const intro: Slide[] = [slide({ durationMs: 4000, fadeMs: 800 }), slide({ durationMs: 3000, fadeMs: 500 })];
    const outro: Slide[] = [slide({ durationMs: 5000, fadeMs: 1000 })];
    // intro: (800*2+4000) + (500*2+3000) = 5600 + 4000 = 9600
    // outro: 1000*2+5000 = 7000
    const plan = computeBurnDurationPlan(intro, outro, 3_600_000);
    expect(plan.introMs).toBe(9600);
    expect(plan.outroMs).toBe(7000);
    expect(plan.masterMs).toBe(3_600_000);
    expect(plan.totalMs).toBe(9600 + 7000 + 3_600_000);
  });

  it("returns zero intro/outro for an empty document", () => {
    const plan = computeBurnDurationPlan([], [], 1000);
    expect(plan).toEqual({ introMs: 0, outroMs: 0, masterMs: 1000, totalMs: 1000 });
  });
});

describe("ffmpeg-plan: isDurationWithinTolerance", () => {
  it("accepts a difference within the default ±500ms tolerance", () => {
    expect(isDurationWithinTolerance(10_000, 10_400)).toBe(true);
    expect(isDurationWithinTolerance(10_000, 9_600)).toBe(true);
  });

  it("rejects a difference beyond the default tolerance", () => {
    expect(isDurationWithinTolerance(10_000, 10_600)).toBe(false);
  });

  it("respects a custom tolerance", () => {
    expect(isDurationWithinTolerance(10_000, 10_800, 1000)).toBe(true);
    expect(isDurationWithinTolerance(10_000, 10_800, 100)).toBe(false);
  });
});

describe("ffmpeg-plan: computeThumbnailOffsetSeconds", () => {
  it("picks 10% into the duration when that is above the 3s floor", () => {
    expect(computeThumbnailOffsetSeconds(100)).toBe(10);
    expect(computeThumbnailOffsetSeconds(3600)).toBe(360);
  });

  it("clamps to at least 3 seconds for a short master", () => {
    expect(computeThumbnailOffsetSeconds(10)).toBe(3); // 10% of 10 = 1, clamped up to 3
    expect(computeThumbnailOffsetSeconds(20)).toBe(3); // 10% of 20 = 2, clamped up to 3
  });

  it("never seeks past end-of-file for a very short master", () => {
    // 10% would be within bounds, but the floor (3s) would exceed duration - margin.
    expect(computeThumbnailOffsetSeconds(3)).toBeLessThanOrEqual(2.5);
    expect(computeThumbnailOffsetSeconds(1)).toBeLessThanOrEqual(0.5);
  });

  it("returns 0 for a zero or negative duration", () => {
    expect(computeThumbnailOffsetSeconds(0)).toBe(0);
    expect(computeThumbnailOffsetSeconds(-5)).toBe(0);
  });
});

describe("ffmpeg-plan: buildThumbnailFrameArgs", () => {
  it("seeks before -i and grabs exactly one frame", () => {
    const args = buildThumbnailFrameArgs("/tmp/master.mp4", 12.345, "/tmp/thumb.jpg");
    const seekIdx = args.indexOf("-ss");
    const inputIdx = args.indexOf("-i");
    expect(seekIdx).toBeGreaterThanOrEqual(0);
    expect(seekIdx).toBeLessThan(inputIdx);
    expect(flagValue(args, "-ss")).toBe("12.345");
    expect(flagValue(args, "-i")).toBe("/tmp/master.mp4");
    expect(flagValue(args, "-frames:v")).toBe("1");
    expect(args.at(-1)).toBe("/tmp/thumb.jpg");
  });
});

// ─── src/services/video-burn.ts — pure re-burn delta helpers ────────────

import { computeIntroDelta, shiftPositionSeconds } from "../../src/services/video-burn.ts";

describe("computeIntroDelta", () => {
  it("is a no-op on a first burn (previous is null)", () => {
    expect(computeIntroDelta(null, 9600)).toEqual({ deltaMs: 0, changed: false });
  });

  it("is a no-op when the new intro is the same length", () => {
    expect(computeIntroDelta(9600, 9600)).toEqual({ deltaMs: 0, changed: false });
  });

  it("reports a positive delta when the intro grew", () => {
    expect(computeIntroDelta(8000, 9600)).toEqual({ deltaMs: 1600, changed: true });
  });

  it("reports a negative delta when the intro shrank", () => {
    expect(computeIntroDelta(9600, 8000)).toEqual({ deltaMs: -1600, changed: true });
  });
});

describe("shiftPositionSeconds", () => {
  it("shifts forward by a positive delta", () => {
    expect(shiftPositionSeconds(100, 5000)).toBe(105);
  });

  it("shifts backward by a negative delta", () => {
    expect(shiftPositionSeconds(100, -5000)).toBe(95);
  });

  it("clamps a negative result at 0", () => {
    expect(shiftPositionSeconds(3, -10_000)).toBe(0);
  });

  it("clamps at the known duration when provided", () => {
    expect(shiftPositionSeconds(590, 30_000, 600)).toBe(600);
  });

  it("does not clamp against a duration when none is known", () => {
    expect(shiftPositionSeconds(590, 30_000)).toBe(620);
  });

  // position_seconds is an INTEGER column and the bulk SQL adds a whole-second
  // delta, so this helper must round identically or it documents behaviour the
  // shipped query does not implement.
  it("rounds a sub-second delta to no shift at all", () => {
    expect(shiftPositionSeconds(100, 400)).toBe(100);
    expect(shiftPositionSeconds(100, -400)).toBe(100);
  });

  it("rounds a fractional delta to the nearest whole second", () => {
    expect(shiftPositionSeconds(100, 1600)).toBe(102);
    expect(shiftPositionSeconds(100, 2400)).toBe(102);
  });

  it("always returns an integer, matching the column type", () => {
    const out = shiftPositionSeconds(100, 1234);
    expect(Number.isInteger(out)).toBe(true);
  });
});

// ─── submitVideoBurnJob / reconcileVideoBurnRows — mocked AWS + DB ───────

const {
  mockSend,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockPutObject,
} = vi.hoisted(() => {
  const mockSend = vi.fn((_command?: unknown): Promise<Record<string, unknown>> =>
    Promise.resolve({ jobId: "batch-job-1" }),
  );
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn((_payload?: Record<string, unknown>) => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockPutObject = vi.fn(() => Promise.resolve());
  return { mockSend, mockUpdateWhere, mockUpdateSet, mockUpdate, mockPutObject };
});

vi.mock("@aws-sdk/client-batch", () => ({
  BatchClient: class {
    send(command: unknown) {
      return mockSend(command);
    }
  },
  SubmitJobCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DescribeJobsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: { update: mockUpdate },
}));

vi.mock("../../src/services/s3.ts", () => ({
  putObject: mockPutObject,
  storageEnvForContainer: () => [
    { name: "S3_ENDPOINT", value: "" },
    { name: "S3_ACCESS_KEY_ID", value: "key" },
    { name: "S3_SECRET_ACCESS_KEY", value: "secret" },
    { name: "S3_REGION", value: "eu-west-3" },
  ],
}));

describe("submitVideoBurnJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("writes the slide document to S3, submits Batch with the documented env vars, and persists burnJobId/burnStatus", async () => {
    const { submitVideoBurnJob } = await import("../../src/services/video-burn.ts");

    const slides = { version: 1, intro: [], outro: [] };
    const result = await submitVideoBurnJob({
      videoId: 42,
      masterS3Key: "events/E1/masters/master.mp4",
      slides,
      title: "Morning Session",
    });

    expect(result.jobId).toBe("batch-job-1");

    expect(mockPutObject).toHaveBeenCalledWith(
      "video-burn/42/slides.json",
      Buffer.from(JSON.stringify(slides)),
      "application/json",
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as {
      input: { containerOverrides: { environment: Array<{ name: string; value: string }> } };
    };
    const env = Object.fromEntries(
      command.input.containerOverrides.environment.map((e) => [e.name, e.value]),
    );
    expect(env.VIDEO_ID).toBe("42");
    expect(env.MASTER_S3_KEY).toBe("events/E1/masters/master.mp4");
    expect(env.SLIDES_S3_KEY).toBe("video-burn/42/slides.json");
    expect(env.OUTPUT_S3_KEY).toBe("video-burn/42/merged.mp4");
    expect(env.TITLE).toBe("Morning Session");
    expect(env.WEBHOOK_URL).toMatch(/\/api\/webhooks\/video-burn$/);
    expect(env.JOB_ID).toBeTruthy();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnJobId: "batch-job-1", burnStatus: "queued", burnError: null }),
    );
  });

  it("throws when AWS Batch returns no jobId", async () => {
    mockSend.mockResolvedValueOnce({});
    const { submitVideoBurnJob } = await import("../../src/services/video-burn.ts");
    await expect(
      submitVideoBurnJob({
        videoId: 1,
        masterS3Key: "k",
        slides: { version: 1, intro: [], outro: [] },
        title: "t",
      }),
    ).rejects.toThrow(/no jobId/);
  });
});

describe("reconcileVideoBurnRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ jobs: [] });
  });

  function row(overrides: Partial<{ id: number; burnStatus: string; burnJobId: string | null; updatedAt: Date }>) {
    return {
      id: 1,
      burnStatus: "queued",
      burnJobId: "batch-1",
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("marks a queued row failed when AWS Batch reports FAILED", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [{ jobId: "batch-1", status: "FAILED", statusReason: "OOMKilled" }],
    });
    const { reconcileVideoBurnRows } = await import("../../src/services/video-burn.ts");
    await reconcileVideoBurnRows([row({})]);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnStatus: "failed", burnError: "OOMKilled" }),
    );
  });

  it("moves a queued row to running (not \"processing\") when AWS Batch reports RUNNING", async () => {
    mockSend.mockResolvedValueOnce({ jobs: [{ jobId: "batch-1", status: "RUNNING" }] });
    const { reconcileVideoBurnRows } = await import("../../src/services/video-burn.ts");
    await reconcileVideoBurnRows([row({})]);

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ burnStatus: "running" }));
  });

  it("never describes or updates rows already done/failed", async () => {
    const { reconcileVideoBurnRows } = await import("../../src/services/video-burn.ts");
    await reconcileVideoBurnRows([row({ burnStatus: "done" }), row({ id: 2, burnStatus: "failed" })]);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("marks a row failed as aged-out when missing from Batch and submitted (via updatedAt) >15min ago", async () => {
    mockSend.mockResolvedValueOnce({ jobs: [] });
    const { reconcileVideoBurnRows } = await import("../../src/services/video-burn.ts");
    await reconcileVideoBurnRows([row({ updatedAt: new Date(Date.now() - 16 * 60_000) })]);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnStatus: "failed", burnError: expect.stringMatching(/aged out/) }),
    );
  });

  it("swallows AWS errors without throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("ThrottlingException"));
    const { reconcileVideoBurnRows } = await import("../../src/services/video-burn.ts");
    await expect(reconcileVideoBurnRows([row({})])).resolves.toBeUndefined();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

// ─── ffmpeg-plan: findConcatParamMismatches ──────────────────────────────
//
// The concat demuxer does NOT validate that its input segments share
// parameters: given a mismatched segment, ffmpeg exits 0 and writes a file
// whose container metadata describes only the first segment. This was
// verified empirically by deliberately mismatching each parameter in turn —
// see docs/superpowers/notes/2026-08-21-slide-pipeline-verification.md.
// This gate is what catches that failure mode; isDurationWithinTolerance
// (tested above) is a separate, independent gate over duration only.

describe("ffmpeg-plan: findConcatParamMismatches", () => {
  it("reports no mismatches when the merged output matches the master exactly", () => {
    expect(findConcatParamMismatches(PARAMS, PARAMS)).toEqual([]);
  });

  it("reports one resolution mismatch, naming both widths, when width differs", () => {
    const actual: MasterParams = { ...PARAMS, width: 1280 };
    const mismatches = findConcatParamMismatches(actual, PARAMS);
    expect(mismatches).toEqual(["resolution 1280x1080 != master 1920x1080"]);
  });

  it("reports one resolution mismatch, naming both heights, when height differs", () => {
    const actual: MasterParams = { ...PARAMS, height: 720 };
    const mismatches = findConcatParamMismatches(actual, PARAMS);
    expect(mismatches).toEqual(["resolution 1920x720 != master 1920x1080"]);
  });

  it("reports a video codec mismatch naming both codecs", () => {
    const actual: MasterParams = { ...PARAMS, videoCodec: "hevc" };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual(["video codec hevc != master h264"]);
  });

  it("reports a pixel format mismatch naming both formats", () => {
    const actual: MasterParams = { ...PARAMS, pixelFormat: "yuv422p" };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual([
      "pixel format yuv422p != master yuv420p",
    ]);
  });

  it("reports an audio codec mismatch naming both codecs", () => {
    const actual: MasterParams = { ...PARAMS, audioCodec: "mp3" };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual(["audio codec mp3 != master aac"]);
  });

  it("reports an audio sample rate mismatch naming both rates", () => {
    const actual: MasterParams = { ...PARAMS, audioSampleRate: 44100 };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual([
      "audio sample rate 44100 != master 48000",
    ]);
  });

  it("reports an audio channels mismatch naming both channel counts", () => {
    const actual: MasterParams = { ...PARAMS, audioChannels: 1 };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual(["audio channels 1 != master 2"]);
  });

  it("reports every mismatch when multiple parameters differ simultaneously", () => {
    const actual: MasterParams = {
      ...PARAMS,
      width: 1280,
      height: 720,
      videoCodec: "hevc",
      pixelFormat: "yuv422p",
      audioCodec: "mp3",
      audioSampleRate: 44100,
      audioChannels: 1,
    };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual([
      "resolution 1280x720 != master 1920x1080",
      "video codec hevc != master h264",
      "pixel format yuv422p != master yuv420p",
      "audio codec mp3 != master aac",
      "audio sample rate 44100 != master 48000",
      "audio channels 1 != master 2",
    ]);
  });

  it("does NOT report a duration difference — that is isDurationWithinTolerance's separate gate", () => {
    // Intro segments legitimately change total duration, so duration is
    // deliberately excluded from this parameter-fidelity check.
    const actual: MasterParams = { ...PARAMS, durationSeconds: PARAMS.durationSeconds + 500 };
    expect(findConcatParamMismatches(actual, PARAMS)).toEqual([]);
  });
});

// ─── containers/video-burn/source.ts — resolveMasterSource ──────────────
//
// Pure source-selection logic for the burn container: exactly one of
// MASTER_S3_KEY (browser already PUT the master to S3) or MASTER_SOURCE_URL
// (URL-import-with-slides — the container downloads it itself, see
// entrypoint.ts's main()) must be set. Imported directly, unmocked — same
// as the ffmpeg-plan tests above.

import { resolveMasterSource } from "../../containers/video-burn/source.ts";

describe("video-burn container: resolveMasterSource", () => {
  it("resolves an S3-key source", () => {
    expect(resolveMasterSource({ MASTER_S3_KEY: "video-burn/5/master.mp4" })).toEqual({
      kind: "s3Key",
      key: "video-burn/5/master.mp4",
    });
  });

  it("resolves a URL source", () => {
    expect(resolveMasterSource({ MASTER_SOURCE_URL: "https://example.com/master.mp4" })).toEqual({
      kind: "url",
      url: "https://example.com/master.mp4",
    });
  });

  it("throws when both MASTER_S3_KEY and MASTER_SOURCE_URL are set", () => {
    expect(() =>
      resolveMasterSource({
        MASTER_S3_KEY: "video-burn/5/master.mp4",
        MASTER_SOURCE_URL: "https://example.com/master.mp4",
      }),
    ).toThrow(/exactly one master source/);
  });

  it("throws when neither is set", () => {
    expect(() => resolveMasterSource({})).toThrow(/exactly one master source/);
  });

  it("throws when both are set but blank/whitespace-only", () => {
    expect(() => resolveMasterSource({ MASTER_S3_KEY: "   ", MASTER_SOURCE_URL: "" })).toThrow(
      /exactly one master source/,
    );
  });
});

// ─── submitVideoBurnJob — masterSourceUrl overload ───────────────────────
//
// Reuses the AWS Batch / db / s3 mocks set up above for the masterS3Key
// overload's tests — same file, same vi.mock calls (module-scoped).

describe("submitVideoBurnJob (masterSourceUrl overload)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ jobId: "batch-job-2" });
  });

  it("submits MASTER_SOURCE_URL instead of MASTER_S3_KEY when given a source URL", async () => {
    const { submitVideoBurnJob } = await import("../../src/services/video-burn.ts");

    const slides = { version: 1, intro: [], outro: [] };
    const result = await submitVideoBurnJob({
      videoId: 43,
      masterSourceUrl: "https://example.com/master.mp4",
      slides,
      title: "Imported Session",
    });

    expect(result.jobId).toBe("batch-job-2");

    const command = mockSend.mock.calls[0]![0] as {
      input: { containerOverrides: { environment: Array<{ name: string; value: string }> } };
    };
    const env = Object.fromEntries(
      command.input.containerOverrides.environment.map((e) => [e.name, e.value]),
    );
    expect(env.MASTER_SOURCE_URL).toBe("https://example.com/master.mp4");
    expect(env.MASTER_S3_KEY).toBeUndefined();
  });
});
