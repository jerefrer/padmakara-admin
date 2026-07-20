import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

describe("speaker after a language tag", () => {
  it("detects the speaker abbreviation after a bracketed language tag", () => {
    const r = parseTrackFilename("003 [TIB] KPS - Motivation, how to listen to the teachings.mp3");
    expect(r.speaker).toBe("KPS");
  });

  it("detects the speaker abbreviation after a multi-language bracketed tag", () => {
    const r = parseTrackFilename("002 [TIB+ENG] KPS - Introduction.mp3");
    expect(r.speaker).toBe("KPS");
  });

  it("detects the speaker abbreviation after a language tag with a longer title", () => {
    const r = parseTrackFilename(
      "188 [ENG] WF - Openning prayers - History of the Madhyamika.mp3",
    );
    expect(r.speaker).toBe("WF");
  });

  it("still detects the speaker abbreviation in the untagged form", () => {
    const r = parseTrackFilename("342 WF Chapter 10 - textual outline.mp3");
    expect(r.speaker).toBe("WF");
  });

  it("does not read a title word as a speaker when only a language tag is present", () => {
    const r = parseTrackFilename("001 [TIB] Openning prayers.mp3");
    expect(r.speaker).toBeNull();
  });

  it("does not read a title word as a speaker after a multi-language tag", () => {
    const r = parseTrackFilename("226 [TIB+ENG] Questions and prayers.mp3");
    expect(r.speaker).toBeNull();
  });

  it("does not read TRAD (a language marker) as a speaker in a range definer", () => {
    const r = parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3");
    expect(r.speaker).toBeNull();
  });

  // The language tag used to be stripped AFTER the speaker, so the ^-anchored
  // speaker patterns never matched and the abbreviation stayed in the title.
  it("strips the speaker from the title when a language tag precedes it", () => {
    expect(
      parseTrackFilename("003 [TIB] KPS - Motivation, how to listen to the teachings.mp3").title,
    ).toBe("Motivation, how to listen to the teachings");
    expect(parseTrackFilename("002 [TIB+ENG] KPS - Introduction.mp3").title).toBe("Introduction");
    expect(
      parseTrackFilename("188 [ENG] WF - Openning prayers - History of the Madhyamika.mp3").title,
    ).toBe("Openning prayers - History of the Madhyamika");
  });

  it("leaves no title in the whole event starting with its own speaker abbreviation", () => {
    const names: string[] = JSON.parse(
      readFileSync(
        new URL("../fixtures/shantideva-oct-2019-filenames.json", import.meta.url),
        "utf8",
      ),
    );
    const dirty = names
      .map(parseTrackFilename)
      .filter((t) => t.speaker !== null && new RegExp(`^${t.speaker}\\b`).test(t.title));
    expect(dirty.map((t) => t.originalFilename)).toEqual([]);
  });
});
