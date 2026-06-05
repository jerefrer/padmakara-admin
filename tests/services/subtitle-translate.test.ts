import { describe, it, expect } from "vitest";
import { parseVtt, serializeVtt, groupIntoSentences, recueSentence } from "../../src/services/subtitle-translate";

const SAMPLE = `WEBVTT

00:00:00.000 --> 00:00:00.900
Hello there.

00:00:01.000 --> 00:00:02.000
This is a test

00:00:02.000 --> 00:00:03.000
of subtitles.
`;

describe("parseVtt", () => {
  it("parses cues with seconds", () => {
    const cues = parseVtt(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 0, end: 0.9, text: "Hello there." });
    expect(cues[2]?.text).toBe("of subtitles.");
  });
});

describe("serializeVtt round-trips", () => {
  it("re-emits valid WEBVTT", () => {
    const out = serializeVtt(parseVtt(SAMPLE));
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:00.000 --> 00:00:00.900");
  });
});

describe("groupIntoSentences", () => {
  it("groups cues until sentence-ending punctuation", () => {
    const groups = groupIntoSentences(parseVtt(SAMPLE));
    expect(groups).toHaveLength(2);
    expect(groups[1]?.text).toBe("This is a test of subtitles.");
    expect(groups[1]?.start).toBe(1.0);
    expect(groups[1]?.end).toBe(3.0);
  });
});

describe("recueSentence", () => {
  it("splits a translation across the time span proportionally", () => {
    const cues = recueSentence(
      { start: 0, end: 4, text: "ignored", cueCount: 2 },
      "Bonjour le monde. Comment ça va aujourd'hui ?",
    );
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0]?.start).toBe(0);
    expect(cues[cues.length - 1]?.end).toBe(4);
    for (let i = 1; i < cues.length; i++) expect(cues[i]?.start).toBeGreaterThanOrEqual(cues[i - 1]?.end ?? 0);
  });
});
