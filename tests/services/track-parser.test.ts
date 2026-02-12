import { describe, it, expect } from "vitest";
import {
  parseTrackFilename,
  inferSessions,
} from "../../src/services/track-parser.ts";

describe("parseTrackFilename", () => {
  describe("Pattern 1: Modern format with session info", () => {
    it("parses original language track with AM session", () => {
      const result = parseTrackFilename(
        "001 JKR - The daily practice in three parts-(17 April AM).mp3",
      );
      expect(result.trackNumber).toBe(1);
      expect(result.speaker).toBe("JKR");
      expect(result.title).toBe("The daily practice in three parts");
      expect(result.isTranslation).toBe(false);
      expect(result.date).toBe("April 17");
      expect(result.timePeriod).toBe("morning");
      expect(result.partNumber).toBeNull();
    });

    it("parses PM session track", () => {
      const result = parseTrackFilename(
        "014 JKR - Question about compassion-(17 April PM).mp3",
      );
      expect(result.trackNumber).toBe(14);
      expect(result.speaker).toBe("JKR");
      expect(result.title).toBe("Question about compassion");
      expect(result.timePeriod).toBe("afternoon");
    });

    it("parses track with part number", () => {
      const result = parseTrackFilename(
        "028 JKR - Initial Prayers - Oracoes Iniciais-(18 April AM_part_1).mp3",
      );
      expect(result.trackNumber).toBe(28);
      expect(result.speaker).toBe("JKR");
      expect(result.date).toBe("April 18");
      expect(result.timePeriod).toBe("morning");
      expect(result.partNumber).toBe(1);
    });
  });

  describe("Pattern 2: Translation (TRAD)", () => {
    it("parses TRAD track as Portuguese translation", () => {
      const result = parseTrackFilename(
        "001 TRAD - A pratica diaria em tres partes.mp3",
      );
      expect(result.trackNumber).toBe(1);
      expect(result.isTranslation).toBe(true);
      expect(result.language).toBe("pt");
      expect(result.title).toBe("A pratica diaria em tres partes");
      expect(result.speaker).toBeNull();
    });

    it("parses TRAD track with session info omitted", () => {
      const result = parseTrackFilename(
        "014 TRAD - Questao sobre compaixao.mp3",
      );
      expect(result.trackNumber).toBe(14);
      expect(result.isTranslation).toBe(true);
      expect(result.language).toBe("pt");
      expect(result.title).toBe("Questao sobre compaixao");
    });
  });

  describe("Pattern 3: Language tags in brackets", () => {
    it("parses TIB language tag", () => {
      const result = parseTrackFilename(
        "01 KPS [TIB] Initial prayers 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(1);
      expect(result.speaker).toBe("KPS");
      expect(result.language).toBe("tib");
      expect(result.title).toBe("Initial prayers");
      expect(result.date).toBe("2017-11-14");
      expect(result.isTranslation).toBe(false);
    });

    it("parses ENG language tag", () => {
      const result = parseTrackFilename(
        "02 KPS [ENG] Introduction to the text 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.speaker).toBe("KPS");
      expect(result.language).toBe("en");
      expect(result.title).toBe("Introduction to the text");
    });
  });

  describe("Pattern 4: Underscore prefix translations", () => {
    it("parses underscore-prefixed language tag track", () => {
      const result = parseTrackFilename(
        "02_KPS [ENG] Introduction to the text 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.speaker).toBe("KPS");
      expect(result.language).toBe("en");
      expect(result.title).toBe("Introduction to the text");
    });
  });

  describe("Pattern 5: TRAD with date", () => {
    it("parses TRAD track with ISO date", () => {
      const result = parseTrackFilename(
        "02_TRAD Introducao ao texto 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.isTranslation).toBe(true);
      expect(result.language).toBe("pt");
      expect(result.title).toBe("Introducao ao texto");
      expect(result.date).toBe("2017-11-14");
    });
  });

  describe("Edge cases", () => {
    it("preserves original filename", () => {
      const filename = "001 JKR - Some track-(17 April AM).mp3";
      const result = parseTrackFilename(filename);
      expect(result.originalFilename).toBe(filename);
    });

    it("handles three-digit track numbers", () => {
      const result = parseTrackFilename(
        "356 KPS [TIB] Final prayers 2017-11-20.mp3",
      );
      expect(result.trackNumber).toBe(356);
    });

    it("handles track with no speaker marker", () => {
      const result = parseTrackFilename("017 WF Prayer to Manjushri 2017-11-14.mp3");
      expect(result.trackNumber).toBe(17);
    });

    it("handles various file extensions", () => {
      const mp3 = parseTrackFilename("001 JKR - Test-(17 April AM).mp3");
      const wav = parseTrackFilename("001 JKR - Test-(17 April AM).wav");
      const m4a = parseTrackFilename("001 JKR - Test-(17 April AM).m4a");
      expect(mp3.title).toBe("Test");
      expect(wav.title).toBe("Test");
      expect(m4a.title).toBe("Test");
    });
  });
});

describe("inferSessions", () => {
  it("groups tracks by date and time period", () => {
    // Only pass original (non-translation) tracks to inferSessions
    const tracks = [
      parseTrackFilename("001 JKR - Track 1-(17 April AM).mp3"),
      parseTrackFilename("002 JKR - Track 2-(17 April AM).mp3"),
      parseTrackFilename("003 JKR - Track 3-(17 April PM).mp3"),
      parseTrackFilename("004 JKR - Track 4-(18 April AM).mp3"),
    ].filter((t) => !t.isTranslation);

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.tracks).toHaveLength(2);
    expect(sessions[0]!.timePeriod).toBe("morning");
    expect(sessions[1]!.tracks).toHaveLength(1);
    expect(sessions[1]!.timePeriod).toBe("afternoon");
    expect(sessions[2]!.tracks).toHaveLength(1);
  });

  it("assigns sequential session numbers", () => {
    const tracks = [
      parseTrackFilename("001 JKR - Track 1-(17 April AM).mp3"),
      parseTrackFilename("002 JKR - Track 2-(17 April PM).mp3"),
      parseTrackFilename("003 JKR - Track 3-(18 April AM).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions[0]!.sessionNumber).toBe(1);
    expect(sessions[1]!.sessionNumber).toBe(2);
    expect(sessions[2]!.sessionNumber).toBe(3);
  });

  it("generates readable session titles", () => {
    const tracks = [
      parseTrackFilename("001 JKR - Track-(17 April AM).mp3"),
      parseTrackFilename("002 JKR - Track-(17 April PM).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions[0]!.titleEn).toBe("April 17 - Morning");
    expect(sessions[1]!.titleEn).toBe("April 17 - Afternoon");
  });

  it("handles tracks with part numbers as separate sessions", () => {
    const tracks = [
      parseTrackFilename("001 JKR - Track-(18 April AM_part_1).mp3"),
      parseTrackFilename("002 JKR - Track-(18 April AM_part_2).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.titleEn).toContain("Part 1");
    expect(sessions[1]!.titleEn).toContain("Part 2");
  });

  it("sorts tracks within sessions by track number", () => {
    const tracks = [
      parseTrackFilename("003 JKR - Third-(17 April AM).mp3"),
      parseTrackFilename("001 JKR - First-(17 April AM).mp3"),
      parseTrackFilename("002 JKR - Second-(17 April AM).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions[0]!.tracks[0]!.trackNumber).toBe(1);
    expect(sessions[0]!.tracks[1]!.trackNumber).toBe(2);
    expect(sessions[0]!.tracks[2]!.trackNumber).toBe(3);
  });

  it("handles tracks with ISO dates", () => {
    const tracks = [
      parseTrackFilename("01 KPS [TIB] Prayer 2017-11-14.mp3"),
      parseTrackFilename("02 KPS [TIB] Teaching 2017-11-14.mp3"),
      parseTrackFilename("03 KPS [TIB] Prayer 2017-11-15.mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.date).toBe("2017-11-14");
    expect(sessions[1]!.date).toBe("2017-11-15");
  });
});
