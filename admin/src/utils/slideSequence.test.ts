import { describe, expect, it } from "vitest";
import { makeClipSlide, type Slide, type SlideDocument } from "@slides/types.ts";
import {
  documentDurationMs,
  formatClock,
  formatSecondsLabel,
  isAwaitingFile,
  matchSessionFromDate,
  matchSessionFromFilename,
  sequenceDurationMs,
  sessionLabel,
  slideLabel,
  videoBlockState,
  type SessionOption,
} from "./slideSequence";

const text = (t: string): Slide["lines"][number] => ({ id: t, type: "text", spans: [{ text: t }], size: "md" });
const slide = (over: Partial<Slide> = {}): Slide => ({
  id: "s",
  durationMs: 4000,
  fadeMs: 800,
  lines: [text("Hello")],
  ...over,
});

const SESSIONS: SessionOption[] = [
  { id: 1, sessionNumber: 1, date: "2026-10-10", timePeriod: "morning" },
  { id: 2, sessionNumber: 2, date: "2026-10-10", timePeriod: "evening" },
  { id: 3, sessionNumber: 3, date: "2026-10-11", timePeriod: "morning" },
];

describe("durations", () => {
  it("should count fades on both sides of a slide", () => {
    expect(sequenceDurationMs([slide()])).toBe(5600);
  });

  it("should count the logo clip as 8 seconds", () => {
    expect(sequenceDurationMs([makeClipSlide("c", "padmakara-logo-intro"), slide()])).toBe(13600);
  });

  it("should sum intro and outro for the whole document", () => {
    const doc: SlideDocument = { version: 1, intro: [slide()], outro: [slide()] };
    expect(documentDurationMs(doc)).toBe(11200);
  });

  it("should format clock and seconds labels", () => {
    expect(formatClock(13600)).toBe("0:14");
    expect(formatClock(84000)).toBe("1:24");
    expect(formatSecondsLabel(5600)).toBe("5.6 s");
    expect(formatSecondsLabel(8000)).toBe("8.0 s");
  });
});

describe("slideLabel", () => {
  it("should prefer the role name", () => {
    expect(slideLabel(slide({ role: "session" }), (r) => `role:${r}`)).toBe("role:session");
  });

  it("should fall back to the first text, then to placeholders", () => {
    expect(slideLabel(slide({ lines: [{ id: "a", type: "spacer" }, text("  First   line ")] }))).toBe("First line");
    expect(slideLabel(slide({ lines: [{ id: "i", type: "image", s3Key: "k" }] }))).toBe("Image");
    expect(slideLabel(slide({ lines: [] }))).toBe("Empty slide");
  });
});

describe("sessionLabel", () => {
  it("should number by position in the event and show date and period", () => {
    expect(sessionLabel(SESSIONS[2]!, SESSIONS)).toBe("Session 3 · 11 Oct 2026 · Morning");
  });
});

describe("session matching", () => {
  it("should pre-select the session named by the file's date and period", () => {
    expect(matchSessionFromFilename("JKR-Lx-2026-10-10-AM.mp4", SESSIONS)?.id).toBe(1);
    expect(matchSessionFromFilename("JKR-Lx-2026-10-10-PM.mp4", SESSIONS)?.id).toBe(2);
  });

  it("should not guess when the name has no period", () => {
    expect(matchSessionFromFilename("talk.mp4", SESSIONS)).toBeNull();
  });

  it("should not guess when no session fits", () => {
    expect(matchSessionFromFilename("JKR-Lx-2026-12-01-AM.mp4", SESSIONS)).toBeNull();
  });

  it("should fall back to the date only when exactly one session is on it", () => {
    expect(matchSessionFromDate("2026-10-11", SESSIONS)?.id).toBe(3);
    expect(matchSessionFromDate("2026-10-10", SESSIONS)).toBeNull();
    expect(matchSessionFromDate(null, SESSIONS)).toBeNull();
  });
});

describe("video state", () => {
  const doc: SlideDocument = { version: 1, intro: [slide()], outro: [] };

  it("should be awaiting a file when slides exist and nothing was uploaded", () => {
    expect(isAwaitingFile({ bunnyVideoId: null, slides: doc, burnStatus: "none" })).toBe(true);
  });

  it("should not be awaiting a file once a master or Bunny video exists", () => {
    expect(isAwaitingFile({ bunnyVideoId: null, masterS3Key: "k", slides: doc })).toBe(false);
    expect(isAwaitingFile({ bunnyVideoId: "g", slides: doc })).toBe(false);
  });

  it("should not be awaiting a file without slides", () => {
    expect(isAwaitingFile({ bunnyVideoId: null, slides: null })).toBe(false);
  });

  it("should describe the dashed video block", () => {
    expect(videoBlockState({ hasFile: false, burnStatus: "none" })).toBe("notUploaded");
    expect(videoBlockState({ hasFile: true, burnStatus: "running" })).toBe("burn");
    expect(videoBlockState({ hasFile: true, burnStatus: "done" })).toBe("uploaded");
  });
});
