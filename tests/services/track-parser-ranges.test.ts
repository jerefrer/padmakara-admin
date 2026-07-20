import { describe, it, expect } from "vitest";
import { parseTrackFilename } from "../../src/services/track-parser.ts";

describe("parseTrackFilename - track ranges", () => {
  it("detects a leading NNN-NNN range", () => {
    const r = parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3");
    expect(r.trackRange).toEqual({ start: 1, end: 37 });
    expect(r.trackNumber).toBe(1);
    expect(r.date).toBe("October 6");
    expect(r.timePeriod).toBe("morning");
  });

  it("reduces the title to the period word once range and marker are stripped", () => {
    expect(parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3").title).toBe("Manha");
    expect(parseTrackFilename("129-143 [TRAD] 8_10 - Tarde Parte 1.mp3").title).toBe("Tarde");
  });

  it("detects a three-digit range with a Portuguese part suffix", () => {
    const r = parseTrackFilename("129-143 [TRAD] 8_10 - Tarde Parte 1.mp3");
    expect(r.trackRange).toEqual({ start: 129, end: 143 });
    expect(r.timePeriod).toBe("afternoon");
    expect(r.partNumber).toBe(1);
  });

  it("keeps the [TRAD] language detection intact", () => {
    const r = parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3");
    expect(r.languages).toEqual(["pt"]);
    expect(r.originalLanguage).toBe("pt");
    expect(r.isTranslation).toBe(true);
  });

  it("returns null for an ordinary single-numbered track", () => {
    expect(parseTrackFilename("001 [TIB] Openning prayers.mp3").trackRange).toBeNull();
  });

  it("does not treat a speaker abbreviation after a hyphen as a range", () => {
    expect(parseTrackFilename("01-TPWR-20030614-KAR.mp3").trackRange).toBeNull();
    expect(parseTrackFilename("01-KNP - Questions (open floor).mp3").trackRange).toBeNull();
  });

  it("does not treat an ISO date as a range", () => {
    expect(parseTrackFilename("2019-10-06 - JKR Teaching.mp3").trackRange).toBeNull();
  });
});
