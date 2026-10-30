import { describe, it, expect } from "vitest";
import { mergeIntroSubtitleCues } from "../../../src/lib/slides/intro-subtitles.ts";
import type { Slide, SlideDocument } from "../../../src/lib/slides/types.ts";

function slide(id: string, subtitles?: Slide["subtitles"], durationMs = 4000, fadeMs = 800): Slide {
  return { id, durationMs, fadeMs, lines: [], subtitles };
}

function doc(intro: Slide[], outro: Slide[] = []): SlideDocument {
  return { version: 1, intro, outro };
}

const FIRST_CUE = "00:00:21.120 --> 00:00:22.600\nThis morning";

describe("mergeIntroSubtitleCues", () => {
  it("returns the VTT unchanged when there is no slide document", () => {
    const vtt = `WEBVTT\n\n${FIRST_CUE}\n`;
    expect(mergeIntroSubtitleCues(vtt, null, "pt")).toBe(vtt);
    expect(mergeIntroSubtitleCues(vtt, undefined, "pt")).toBe(vtt);
  });

  it("returns the VTT unchanged when no intro slide has subtitles", () => {
    const vtt = `WEBVTT\n\n${FIRST_CUE}\n`;
    expect(mergeIntroSubtitleCues(vtt, doc([slide("a"), slide("b")]), "pt")).toBe(vtt);
  });

  it("returns the VTT unchanged when subtitles exist only for the other language", () => {
    const vtt = `WEBVTT\n\n${FIRST_CUE}\n`;
    expect(mergeIntroSubtitleCues(vtt, doc([slide("a", { en: ["Hello"] })]), "pt")).toBe(vtt);
  });

  it("times a cue from the end of the fade-in to the end of the hold", () => {
    const out = mergeIntroSubtitleCues(
      `WEBVTT\n\n${FIRST_CUE}\n`,
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).toBe(`WEBVTT\n\n00:00:00.800 --> 00:00:04.800\nOlá\n\n${FIRST_CUE}\n`);
  });

  it("offsets later slides by the full total of the preceding ones", () => {
    const out = mergeIntroSubtitleCues(
      "WEBVTT\n\n00:00:30.000 --> 00:00:31.000\nLater\n",
      doc([slide("a", { pt: ["Um"] }, 2500), slide("b"), slide("c", { pt: ["Três"] })]),
      "pt",
    );
    // a total = 2500 + 1600 = 4100, b total = 4000 + 1600 = 5600, c starts at 9700 + 800
    expect(out).toContain("00:00:00.800 --> 00:00:03.300\nUm");
    expect(out).toContain("00:00:10.500 --> 00:00:14.500\nTrês");
  });

  it("joins multiple lines into one cue", () => {
    const out = mergeIntroSubtitleCues(
      `WEBVTT\n\n${FIRST_CUE}\n`,
      doc([slide("a", { pt: ["Sessão 1 de 4", "10 de outubro de 2026, manhã"] })]),
      "pt",
    );
    expect(out).toContain("Sessão 1 de 4\n10 de outubro de 2026, manhã\n");
  });

  it("drops blank lines and skips slides whose lines are all blank", () => {
    const out = mergeIntroSubtitleCues(
      `WEBVTT\n\n${FIRST_CUE}\n`,
      doc([slide("a", { pt: ["  ", ""] }), slide("b", { pt: ["Dois", " "] })]),
      "pt",
    );
    expect(out.match(/-->/g)).toHaveLength(2);
    expect(out).toContain("Dois\n");
  });

  it("keeps the header and X-TIMESTAMP-MAP lines on top", () => {
    const vtt = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:131280,LOCAL:00:00:00.000\n\n${FIRST_CUE}\n`;
    const out = mergeIntroSubtitleCues(vtt, doc([slide("a", { pt: ["Olá"] })]), "pt");
    expect(out.startsWith("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:131280,LOCAL:00:00:00.000\n\n")).toBe(true);
    expect(out.indexOf("Olá")).toBeLessThan(out.indexOf("This morning"));
  });

  it("does not shift existing cues", () => {
    const out = mergeIntroSubtitleCues(
      `WEBVTT\n\n${FIRST_CUE}\n\n00:00:23.000 --> 00:00:24.000\nSecond\n`,
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).toContain(`${FIRST_CUE}\n\n00:00:23.000 --> 00:00:24.000\nSecond`);
  });

  it("builds a valid VTT from an empty string", () => {
    const out = mergeIntroSubtitleCues("", doc([slide("a", { pt: ["Olá"] })]), "pt");
    expect(out).toBe("WEBVTT\n\n00:00:00.800 --> 00:00:04.800\nOlá\n");
  });

  it("builds a valid VTT from a header-only file", () => {
    const out = mergeIntroSubtitleCues("WEBVTT\n", doc([slide("a", { pt: ["Olá"] })]), "pt");
    expect(out).toBe("WEBVTT\n\n00:00:00.800 --> 00:00:04.800\nOlá\n");
  });

  it("clips an intro cue to end where the first existing cue starts", () => {
    const out = mergeIntroSubtitleCues(
      "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nEarly\n",
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).toContain("00:00:00.800 --> 00:00:03.000\nOlá");
    expect(out).toContain("00:00:03.000 --> 00:00:04.000\nEarly");
  });

  it("drops an intro cue entirely when an existing cue starts before it", () => {
    const out = mergeIntroSubtitleCues(
      "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nVery early\n",
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).not.toContain("Olá");
  });

  it("clips only the intro cues that reach past the first existing cue", () => {
    const out = mergeIntroSubtitleCues(
      "WEBVTT\n\n00:00:06.000 --> 00:00:07.000\nSpeech\n",
      doc([slide("a", { pt: ["Um"] }), slide("b", { pt: ["Dois"] })]),
      "pt",
    );
    // b would run 6.400 -> 10.400, but speech starts at 6.000: nothing is left of it.
    expect(out).toContain("00:00:00.800 --> 00:00:04.800\nUm");
    expect(out).not.toContain("Dois");
  });

  it("ignores the outro", () => {
    const vtt = `WEBVTT\n\n${FIRST_CUE}\n`;
    const d = doc([], [slide("o", { pt: ["Fim"] })]);
    expect(mergeIntroSubtitleCues(vtt, d, "pt")).toBe(vtt);
  });

  it("preserves CRLF line endings", () => {
    const out = mergeIntroSubtitleCues(
      `WEBVTT\r\n\r\n${FIRST_CUE.replace("\n", "\r\n")}\r\n`,
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).toContain("00:00:00.800 --> 00:00:04.800\r\nOlá\r\n\r\n00:00:21.120");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("reads comma milliseconds in existing cues when clipping", () => {
    const out = mergeIntroSubtitleCues(
      "WEBVTT\n\n00:00:02,000 --> 00:00:03,000\nEarly\n",
      doc([slide("a", { pt: ["Olá"] })]),
      "pt",
    );
    expect(out).toContain("00:00:00.800 --> 00:00:02.000\nOlá");
  });

  it("is idempotent, so a merged download re-uploaded is not doubled", () => {
    const d = doc([slide("a", { pt: ["Olá"] }), slide("b", { pt: ["Dois"] })]);
    const once = mergeIntroSubtitleCues(`WEBVTT\n\n${FIRST_CUE}\n`, d, "pt");
    expect(mergeIntroSubtitleCues(once, d, "pt")).toBe(once);
  });
});
