import { describe, it, expect } from "vitest";
import {
  buildClipSegmentArgs,
  computeBurnDurationPlan,
  CONCAT_VIDEO_TIMESCALE,
  type MasterParams,
} from "../../containers/video-burn/ffmpeg-plan.ts";
import { makeClipSlide, type Slide } from "../../src/lib/slides/types.ts";

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

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const textSlide: Slide = { id: "s", durationMs: 4000, fadeMs: 800, lines: [] };

describe("buildClipSegmentArgs", () => {
  const args = buildClipSegmentArgs({
    clipPath: "/app/assets/padmakara-logo-intro.mp4",
    outputPath: "/tmp/intro-seg-0.mp4",
    params: PARAMS,
    durationMs: 8000,
  });

  it("should re-encode with the master's codec, pixel format, size and timescale", () => {
    expect(flagValue(args, "-c:v")).toBe("libx264");
    expect(flagValue(args, "-pix_fmt")).toBe("yuv420p");
    expect(flagValue(args, "-s")).toBe("1920x1080");
    expect(flagValue(args, "-profile:v")).toBe("high");
    expect(flagValue(args, "-video_track_timescale")).toBe(String(CONCAT_VIDEO_TIMESCALE));
  });

  it("should conform the frame rate and letterbox to the master's resolution", () => {
    const vf = flagValue(args, "-vf") ?? "";
    expect(vf).toContain("fps=30000/1001");
    expect(vf).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(vf).toContain("pad=1920:1080");
    expect(vf).toContain("format=yuv420p");
  });

  it("should add a silent audio track in the master's format and ignore the clip's audio", () => {
    expect(args.join(" ")).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    expect(flagValue(args, "-c:a")).toBe("aac");
    expect(flagValue(args, "-ar")).toBe("48000");
    expect(flagValue(args, "-ac")).toBe("2");
    expect(args).toContain("-shortest");
    const at = args.indexOf("-map");
    expect(args.slice(at, at + 4)).toEqual(["-map", "0:v:0", "-map", "1:a:0"]);
    expect(args[args.length - 1]).toBe("/tmp/intro-seg-0.mp4");
  });

  it("should cut the segment to the clip's duration", () => {
    expect(flagValue(args, "-t")).toBe("8.000");
  });

  it("should use a mono silent track when the master is mono", () => {
    const mono = buildClipSegmentArgs({
      clipPath: "c.mp4",
      outputPath: "o.mp4",
      params: { ...PARAMS, audioChannels: 1 },
      durationMs: 8000,
    });
    expect(mono.join(" ")).toContain("channel_layout=mono");
  });
});

describe("computeBurnDurationPlan with a clip slide", () => {
  it("should count the clip's 8 s and ignore the slide's own timing fields", () => {
    const clip = { ...makeClipSlide("c", "padmakara-logo-intro"), durationMs: 1, fadeMs: 999 };
    const plan = computeBurnDurationPlan([clip, textSlide], [], 60_000);
    expect(plan.introMs).toBe(8000 + 5600);
    expect(plan.totalMs).toBe(8000 + 5600 + 60_000);
  });
});
