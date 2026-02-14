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
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.title).toBe("A pratica diaria em tres partes");
      expect(result.speaker).toBeNull();
    });

    it("parses TRAD track with session info omitted", () => {
      const result = parseTrackFilename(
        "014 TRAD - Questao sobre compaixao.mp3",
      );
      expect(result.trackNumber).toBe(14);
      expect(result.isTranslation).toBe(true);
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.title).toBe("Questao sobre compaixao");
    });
  });

  describe("Pattern 3: Language tags in brackets", () => {
    it("parses TIB language tag as Tibetan original (not a translation)", () => {
      const result = parseTrackFilename(
        "01 KPS [TIB] Initial prayers 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(1);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["tib"]);
      expect(result.originalLanguage).toBe("tib");
      expect(result.title).toBe("Initial prayers");
      expect(result.date).toBe("2017-11-14");
      expect(result.isTranslation).toBe(false);
    });

    it("parses ENG bracket tag as English translation", () => {
      const result = parseTrackFilename(
        "02 KPS [ENG] Introduction to the text 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.title).toBe("Introduction to the text");
      expect(result.date).toBe("2017-11-14");
      expect(result.isTranslation).toBe(true);
    });

    it("parses POR bracket tag as Portuguese translation", () => {
      const result = parseTrackFilename(
        "03 KPS [POR] Introducao ao texto 2017-11-15.mp3",
      );
      expect(result.trackNumber).toBe(3);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.title).toBe("Introducao ao texto");
      expect(result.date).toBe("2017-11-15");
      expect(result.isTranslation).toBe(true);
    });

    it("parses FR bracket tag as French translation", () => {
      const result = parseTrackFilename(
        "04 KPS [FR] Introduction au texte 2017-11-15.mp3",
      );
      expect(result.trackNumber).toBe(4);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["fr"]);
      expect(result.originalLanguage).toBe("fr");
      expect(result.title).toBe("Introduction au texte");
      expect(result.date).toBe("2017-11-15");
      expect(result.isTranslation).toBe(true);
    });
  });

  describe("Pattern 4: Underscore prefix translations", () => {
    it("parses underscore-prefixed ENG tag as translation", () => {
      const result = parseTrackFilename(
        "02_KPS [ENG] Introduction to the text 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.title).toBe("Introduction to the text");
      expect(result.isTranslation).toBe(true);
    });
  });

  describe("Pattern 5: TRAD with date", () => {
    it("parses TRAD track with ISO date", () => {
      const result = parseTrackFilename(
        "02_TRAD Introducao ao texto 2017-11-14.mp3",
      );
      expect(result.trackNumber).toBe(2);
      expect(result.isTranslation).toBe(true);
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.title).toBe("Introducao ao texto");
      expect(result.date).toBe("2017-11-14");
    });
  });

  describe("Language and translation detection summary", () => {
    it("no marker defaults to English original", () => {
      const result = parseTrackFilename(
        "001 JKR - Teaching on emptiness-(17 April AM).mp3",
      );
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(false);
    });

    it("TRAD marker sets Portuguese translation", () => {
      const result = parseTrackFilename(
        "001 TRAD - Ensinamento sobre vacuidade.mp3",
      );
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.isTranslation).toBe(true);
    });

    it("[TIB] sets Tibetan original (not translation)", () => {
      const result = parseTrackFilename(
        "01 KPS [TIB] Tibetan chanting 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["tib"]);
      expect(result.originalLanguage).toBe("tib");
      expect(result.isTranslation).toBe(false);
    });

    it("[ENG] sets English translation (bug fix)", () => {
      const result = parseTrackFilename(
        "02 KPS [ENG] English translation of chanting 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
    });

    it("[POR] sets Portuguese translation", () => {
      const result = parseTrackFilename(
        "03 KPS [POR] Traducao portuguesa 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
      expect(result.isTranslation).toBe(true);
    });

    it("[FR] sets French translation", () => {
      const result = parseTrackFilename(
        "04 KPS [FR] Traduction francaise 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["fr"]);
      expect(result.originalLanguage).toBe("fr");
      expect(result.isTranslation).toBe(true);
    });
  });

  describe("Pattern 6: Hyphen-separated with compact date", () => {
    it("parses 01-TPWR-20030614-KAR.mp3 format", () => {
      const result = parseTrackFilename("01-TPWR-20030614-KAR.mp3");
      expect(result.trackNumber).toBe(1);
      expect(result.speaker).toBe("TPWR");
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(false);
      expect(result.date).toBe("2003-06-14");
    });

    it("parses higher track numbers with compact date", () => {
      const result = parseTrackFilename("16-TPWR-20030614-KAR.mp3");
      expect(result.trackNumber).toBe(16);
      expect(result.speaker).toBe("TPWR");
      expect(result.date).toBe("2003-06-14");
    });
  });

  describe("Date extraction", () => {
    it("extracts ISO format date (YYYY-MM-DD)", () => {
      const result = parseTrackFilename(
        "01 KPS [TIB] Prayers 2017-11-14.mp3",
      );
      expect(result.date).toBe("2017-11-14");
    });

    it("extracts parenthetical date format (DD Month)", () => {
      const result = parseTrackFilename(
        "001 JKR - Teaching-(17 April AM).mp3",
      );
      expect(result.date).toBe("April 17");
    });

    it("extracts compact date format (YYYYMMDD)", () => {
      const result = parseTrackFilename("07-JKR-20031130-OEI.mp3");
      expect(result.date).toBe("2003-11-30");
    });

    it("returns null when no date present", () => {
      const result = parseTrackFilename(
        "001 TRAD - Some translation.mp3",
      );
      expect(result.date).toBeNull();
    });
  });

  describe("Pattern 7: Date-prefixed filenames (YYYYMMDD)", () => {
    it("treats 20250810 as a date prefix, not a track number", () => {
      const result = parseTrackFilename("20250810-PART_1 [ENG].mp3");
      expect(result.trackNumber).toBe(0);
      expect(result.date).toBe("2025-08-10");
      expect(result.title).toBe("PART 1");
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
    });

    it("treats 20241027 as a date prefix with TRAD marker", () => {
      const result = parseTrackFilename("20241027 - TRAD Session 6.m4a");
      expect(result.trackNumber).toBe(0);
      expect(result.date).toBe("2024-10-27");
      expect(result.title).toBe("Session 6");
      expect(result.isTranslation).toBe(true);
      expect(result.languages).toEqual(["pt"]);
      expect(result.originalLanguage).toBe("pt");
    });

    it("treats 20240707 as a date prefix with speaker", () => {
      const result = parseTrackFilename(
        "20240707-PWR-MANI_KABUM-VOL2-AUDIO_ONLY-FRANCE.mp3",
      );
      expect(result.trackNumber).toBe(0);
      expect(result.date).toBe("2024-07-07");
      expect(result.speaker).toBe("PWR");
      expect(result.title).toBe("MANI KABUM-VOL2-AUDIO ONLY-FRANCE");
    });

    it("does not treat small numbers as dates (01, 001, etc.)", () => {
      const result = parseTrackFilename("01-TPWR-20030614-KAR.mp3");
      expect(result.trackNumber).toBe(1);
      expect(result.speaker).toBe("TPWR");
    });

    it("treats ISO date prefix as date, not track number", () => {
      const result = parseTrackFilename(
        "2025-10-27-Guru_Yoga [ENG - Audio].m4a",
      );
      expect(result.trackNumber).toBe(0);
      expect(result.date).toBe("2025-10-27");
      expect(result.title).toBe("Guru Yoga");
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
    });
  });

  describe("Bracket language with extra content", () => {
    it("extracts language from [ENG - Audio]", () => {
      const result = parseTrackFilename(
        "01 KPS [ENG - Audio] Introduction 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
      expect(result.title).toBe("Introduction");
    });

    it("extracts language from [ENG - Áudio]", () => {
      const result = parseTrackFilename(
        "02 KPS [ENG - Áudio] Teaching 2017-11-15.mp3",
      );
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
      expect(result.title).toBe("Teaching");
    });

    it("still handles plain [ENG] bracket notation", () => {
      const result = parseTrackFilename(
        "02 KPS [ENG] Introduction to the text 2017-11-14.mp3",
      );
      expect(result.languages).toEqual(["en"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(true);
    });
  });

  describe("Combo speakers (Pattern 6)", () => {
    it("parses KPS+JKR as two co-teaching speakers", () => {
      const result = parseTrackFilename(
        "016 KPS+JKR Intention in practicing.mp3",
      );
      expect(result.trackNumber).toBe(16);
      expect(result.speakers).toEqual(["KPS", "JKR"]);
      expect(result.speaker).toBe("KPS");
      expect(result.languages).toEqual(["en"]);
      expect(result.isTranslation).toBe(false);
    });

    it("parses JKR+TRAD as original+translation mixed", () => {
      const result = parseTrackFilename(
        "019 JKR+TRAD - Initial prayers-(7 April AM_part_1).mp3",
      );
      expect(result.trackNumber).toBe(19);
      expect(result.speaker).toBe("JKR");
      expect(result.speakers).toEqual(["JKR"]);
      expect(result.languages).toEqual(["en", "pt"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(false); // it's BOTH, not just translation
    });

    it("parses PWR+TRAD combo", () => {
      const result = parseTrackFilename(
        "050 PWR+TRAD - Conclusion of the teaching-(21 April PM part 2).mp3",
      );
      expect(result.trackNumber).toBe(50);
      expect(result.speaker).toBe("PWR");
      expect(result.languages).toEqual(["en", "pt"]);
      expect(result.isTranslation).toBe(false);
      expect(result.timePeriod).toBe("afternoon");
      expect(result.partNumber).toBe(2);
    });

    it("parses PWR&TRAD combo (ampersand separator)", () => {
      const result = parseTrackFilename(
        "021 PWR&TRAD - kindness of our mother-bondade da nossa mae.mp3",
      );
      expect(result.trackNumber).toBe(21);
      expect(result.speaker).toBe("PWR");
      expect(result.title).toBe("kindness of our mother-bondade da nossa mae");
      expect(result.languages).toEqual(["en", "pt"]);
      expect(result.originalLanguage).toBe("en");
      expect(result.isTranslation).toBe(false);
    });
  });

  describe("Underscore handling in titles", () => {
    it("replaces underscores with spaces in title", () => {
      const result = parseTrackFilename("20250810-Guru_Yoga [ENG].mp3");
      expect(result.title).toBe("Guru Yoga");
    });

    it("replaces multiple underscores with spaces", () => {
      const result = parseTrackFilename(
        "20240707-PWR-MANI_KABUM-VOL2-AUDIO_ONLY-FRANCE.mp3",
      );
      expect(result.title).toContain("MANI KABUM");
      expect(result.title).toContain("AUDIO ONLY");
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

    it("detects all-caps speaker without separator (e.g. JKR Title)", () => {
      const result = parseTrackFilename(
        "001 JKR How to relate to our mind-(12 April AM_part_1).mp3",
      );
      expect(result.speaker).toBe("JKR");
      expect(result.title).toBe("How to relate to our mind");
      expect(result.trackNumber).toBe(1);
      expect(result.timePeriod).toBe("morning");
      expect(result.partNumber).toBe(1);
    });

    it("detects WF speaker without separator", () => {
      const result = parseTrackFilename("017 WF Prayer to Manjushri 2017-11-14.mp3");
      expect(result.trackNumber).toBe(17);
      expect(result.speaker).toBe("WF");
      expect(result.title).toBe("Prayer to Manjushri");
    });

    it("does not capture mixed-case words as speakers", () => {
      const result = parseTrackFilename("001 How to meditate.mp3");
      expect(result.speaker).toBeNull();
      expect(result.title).toBe("How to meditate");
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

  it("handles tracks with ISO dates and groups by date", () => {
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

  it("groups TRAD translation tracks with originals by track number", () => {
    const tracks = [
      parseTrackFilename("001 JKR - The daily practice in three parts-(17 April AM).mp3"),
      parseTrackFilename("001 TRAD - A pratica diaria em tres partes.mp3"),
      parseTrackFilename("002 JKR - The four thoughts-(17 April AM).mp3"),
      parseTrackFilename("002 TRAD - Os quatro pensamentos.mp3"),
      parseTrackFilename("014 JKR - Question about compassion-(17 April PM).mp3"),
      parseTrackFilename("014 TRAD - Questao sobre compaixao.mp3"),
    ];

    const sessions = inferSessions(tracks);
    // Should be 2 sessions (AM + PM), NOT 3 (AM + PM + unknown TRAD)
    expect(sessions).toHaveLength(2);

    // AM session: 2 originals + 2 translations = 4 tracks
    expect(sessions[0]!.tracks).toHaveLength(4);
    expect(sessions[0]!.timePeriod).toBe("morning");

    // PM session: 1 original + 1 translation = 2 tracks
    expect(sessions[1]!.tracks).toHaveLength(2);
    expect(sessions[1]!.timePeriod).toBe("afternoon");

    // Within each track number, original comes before translation
    expect(sessions[0]!.tracks[0]!.isTranslation).toBe(false);
    expect(sessions[0]!.tracks[1]!.isTranslation).toBe(true);
    expect(sessions[0]!.tracks[0]!.trackNumber).toBe(1);
    expect(sessions[0]!.tracks[1]!.trackNumber).toBe(1);
  });

  it("uses original track for session title, not translation", () => {
    const tracks = [
      parseTrackFilename("001 TRAD - A pratica diaria.mp3"),
      parseTrackFilename("001 JKR - The daily practice-(17 April AM).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.titleEn).toBe("April 17 - Morning");
    expect(sessions[0]!.date).toBe("April 17");
  });

  it("groups bracket-notation translation tracks with Tibetan originals by date", () => {
    const tracks = [
      parseTrackFilename("01 KPS [TIB] Prayer 2017-11-14.mp3"),
      parseTrackFilename("02 KPS [ENG] Prayer translation 2017-11-14.mp3"),
      parseTrackFilename("03 KPS [TIB] Teaching 2017-11-15.mp3"),
      parseTrackFilename("04 KPS [ENG] Teaching translation 2017-11-15.mp3"),
    ];

    const sessions = inferSessions(tracks);
    // Both TIB and ENG tracks for same date have date set, so they group together
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.date).toBe("2017-11-14");
    expect(sessions[0]!.tracks).toHaveLength(2);
    expect(sessions[1]!.date).toBe("2017-11-15");
    expect(sessions[1]!.tracks).toHaveLength(2);
  });

  it("splits tracks into sessions by date/time/part from underscored filenames", () => {
    const tracks = [
      parseTrackFilename("001 JKR - Introduction (8 April_AM_Part 1).mp3"),
      parseTrackFilename("002 JKR - Power of resolution (8 April_AM_Part 2).mp3"),
      parseTrackFilename("003 JKR - Dying (8 April_PM).mp3"),
      parseTrackFilename("004 JKR - Suffering (9 April_AM_Part 1).mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(4);
    expect(sessions[0]!.date).toBe("April 8");
    expect(sessions[0]!.timePeriod).toBe("morning");
    expect(sessions[0]!.partNumber).toBe(1);
    expect(sessions[1]!.partNumber).toBe(2);
    expect(sessions[2]!.timePeriod).toBe("afternoon");
    expect(sessions[2]!.partNumber).toBeNull();
    expect(sessions[3]!.date).toBe("April 9");
  });

  it("matches TRAD tracks to underscored-session originals by track number", () => {
    const tracks = [
      parseTrackFilename("005 JKR - How do we relate to ourselves (8 April_AM_Part 1).mp3"),
      parseTrackFilename("005 TRAD - Como nos relacionamos connosco.mp3"),
    ];

    const sessions = inferSessions(tracks);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks).toHaveLength(2);
    expect(sessions[0]!.date).toBe("April 8");
    expect(sessions[0]!.timePeriod).toBe("morning");
    expect(sessions[0]!.partNumber).toBe(1);
  });
});

describe("parseTrackFilename - underscored/hyphenated session info", () => {
  it("parses underscore-separated session info: (8 April_AM_Part 1)", () => {
    const result = parseTrackFilename(
      "002 JKR - Introduction (8 April_AM_Part 1).mp3",
    );
    expect(result.title).toBe("Introduction");
    expect(result.date).toBe("April 8");
    expect(result.timePeriod).toBe("morning");
    expect(result.partNumber).toBe(1);
  });

  it("parses underscore-separated PM session: (20 April_PM_part 1)", () => {
    const result = parseTrackFilename(
      "014 JKR - How to see the teacher-(20 April_PM_part 1).mp3",
    );
    expect(result.title).toBe("How to see the teacher");
    expect(result.date).toBe("April 20");
    expect(result.timePeriod).toBe("afternoon");
    expect(result.partNumber).toBe(1);
  });

  it("parses hyphen-separated session info: (20 April-AM-part 2)", () => {
    const result = parseTrackFilename(
      "009 JKR - The purpose of our practice-(20 April-AM-part 2).mp3",
    );
    expect(result.title).toBe("The purpose of our practice");
    expect(result.date).toBe("April 20");
    expect(result.timePeriod).toBe("morning");
    expect(result.partNumber).toBe(2);
  });

  it("parses session info without separator before part number: (21 April AM part2)", () => {
    const result = parseTrackFilename(
      "031 JKR - The Excellent Path of Liberation-Guru Yoga-(21 April AM part2).mp3",
    );
    expect(result.title).toBe("The Excellent Path of Liberation-Guru Yoga");
    expect(result.date).toBe("April 21");
    expect(result.timePeriod).toBe("morning");
    expect(result.partNumber).toBe(2);
  });

  it("parses non-parenthesized session info at end: -21_April_AM_part_1", () => {
    const result = parseTrackFilename(
      "027 JKR - About the preliminary practices-21_April_AM_part_1.mp3",
    );
    expect(result.title).toBe("About the preliminary practices");
    expect(result.date).toBe("April 21");
    expect(result.timePeriod).toBe("morning");
    expect(result.partNumber).toBe(1);
  });

  it("parses Portuguese month name: (21 Abril PM part 2)", () => {
    const result = parseTrackFilename(
      "050 JKR - Guru Yoga conclusion-(21 Abril PM part 2).mp3",
    );
    expect(result.title).toBe("Guru Yoga conclusion");
    expect(result.date).toBe("April 21");
    expect(result.timePeriod).toBe("afternoon");
    expect(result.partNumber).toBe(2);
  });

  it("parses PM-only session info without part number: (8 April_PM)", () => {
    const result = parseTrackFilename(
      "013 JKR - Dying - power of positive deeds (8 April_PM).mp3",
    );
    expect(result.title).toBe("Dying - power of positive deeds");
    expect(result.date).toBe("April 8");
    expect(result.timePeriod).toBe("afternoon");
    expect(result.partNumber).toBeNull();
  });
});
