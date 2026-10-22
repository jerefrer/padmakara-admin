import { describe, it, expect } from "vitest";
import { parseTrackFilename, inferSessions } from "../../src/services/track-parser.ts";

// Edge cases not covered by track-parser.test.ts / track-parser-ranges.test.ts:
// language-marker spellings and casing, separators, diacritics, missing parts.

describe("parseTrackFilename - language markers", () => {
  it("should read the Portuguese spelling [TIBETANO] as a Tibetan original", () => {
    const r = parseTrackFilename("001 KPS [TIBETANO] Orações.mp3");

    expect(r.languages).toEqual(["tib"]);
    expect(r.isTranslation).toBe(false);
    expect(r.title).toBe("Orações");
  });

  it("should read the long form [TIBETAN] as a Tibetan original", () => {
    const r = parseTrackFilename("001 KPS [TIBETAN] Title.mp3");

    expect(r.languages).toEqual(["tib"]);
    expect(r.title).toBe("Title");
  });

  it("should read a lowercase tag [eng] like [ENG]", () => {
    const r = parseTrackFilename("001 KPS [eng] Prayers.mp3");

    expect(r.languages).toEqual(["en"]);
    expect(r.isTranslation).toBe(true);
    expect(r.title).toBe("Prayers");
  });

  it("should read a mixed-case multi-language tag [Tib+Eng]", () => {
    const r = parseTrackFilename("001 KPS [Tib+Eng] Prayers.mp3");

    expect(r.languages).toEqual(["tib", "en"]);
    expect(r.originalLanguage).toBe("tib");
  });

  it("should split multi-language tags on a slash", () => {
    const r = parseTrackFilename("001 KPS [TIB/ENG] Prayers.mp3");

    expect(r.languages).toEqual(["tib", "en"]);
    expect(r.isTranslation).toBe(false);
    expect(r.title).toBe("Prayers");
  });

  it("should split multi-language tags on an ampersand", () => {
    const r = parseTrackFilename("001 KPS [TIB&POR] Prayers.mp3");

    expect(r.languages).toEqual(["tib", "pt"]);
    expect(r.title).toBe("Prayers");
  });

  it("should read [FRA] as a French translation", () => {
    const r = parseTrackFilename("001 KPS [FRA] Titre.mp3");

    expect(r.languages).toEqual(["fr"]);
    expect(r.isTranslation).toBe(true);
  });

  it("should fall back to an English original for an unknown tag, and still strip it", () => {
    const r = parseTrackFilename("001 KPS [XYZ] Prayers.mp3");

    expect(r.languages).toEqual(["en"]);
    expect(r.isTranslation).toBe(false);
    expect(r.title).toBe("Prayers");
  });

  it("should treat a tag with no speaker as a language marker, not a speaker", () => {
    const r = parseTrackFilename("001 [ENG] Title.mp3");

    expect(r.speaker).toBeNull();
    expect(r.languages).toEqual(["en"]);
    expect(r.title).toBe("Title");
  });

  it("should read a lowercase 'trad' marker as a Portuguese translation", () => {
    const r = parseTrackFilename("001 trad - Introdução.mp3");

    expect(r.isTranslation).toBe(true);
    expect(r.languages).toEqual(["pt"]);
    expect(r.speaker).toBeNull();
    expect(r.title).toBe("Introdução");
  });

  it("should strip an accented language tag [PORTUGUÊS] from the title", () => {
    const r = parseTrackFilename("001 KPS [PORTUGUÊS] Meditação.mp3");

    expect(r.languages).toEqual(["pt"]);
    expect(r.title).toBe("Meditação");
  });

  it("should strip an accented language tag [FRANCÊS] from the title", () => {
    const r = parseTrackFilename("001 KPS [FRANCÊS] Titre.mp3");

    expect(r.languages).toEqual(["fr"]);
    expect(r.title).toBe("Titre");
  });

  it("should strip a comma-and-space separated tag [TIB, ENG] from the title", () => {
    const r = parseTrackFilename("001 KPS [TIB, ENG] Prayers.mp3");

    expect(r.languages).toEqual(["tib", "en"]);
    expect(r.title).toBe("Prayers");
  });
});

describe("parseTrackFilename - separators and diacritics", () => {
  it("should parse hyphen-only separators", () => {
    const r = parseTrackFilename("001-JKR-Title.mp3");

    expect(r.trackNumber).toBe(1);
    expect(r.speaker).toBe("JKR");
    expect(r.title).toBe("Title");
  });

  it("should tolerate repeated spaces around the separators", () => {
    const r = parseTrackFilename("001  JKR  -  Title.mp3");

    expect(r.speaker).toBe("JKR");
    expect(r.title).toBe("Title");
  });

  it("should keep Portuguese diacritics in the title", () => {
    const r = parseTrackFilename("001 JKR - Meditação sobre a compaixão.mp3");

    expect(r.title).toBe("Meditação sobre a compaixão");
  });

  it("should read an uppercase extension", () => {
    const r = parseTrackFilename("001 JKR - Title.MP3");

    expect(r.title).toBe("Title");
  });

  it("should read 'Manhã' (with tilde) as morning", () => {
    const r = parseTrackFilename("001 JKR - Title-(7 Abril Manhã).mp3");

    expect(r.timePeriod).toBe("morning");
    expect(r.date).toBe("April 7");
    expect(r.title).toBe("Title");
  });

  it("should read 'Tarde' as afternoon and keep an accented title", () => {
    const r = parseTrackFilename("001 JKR - Prática diária-(17 Abril Tarde).mp3");

    expect(r.timePeriod).toBe("afternoon");
    expect(r.title).toBe("Prática diária");
  });

  it("should read 'Noite' and 'Evening' as evening", () => {
    expect(parseTrackFilename("001 JKR - T-(7 Abril Noite).mp3").timePeriod).toBe("evening");
    expect(parseTrackFilename("001 JKR - T-(7 April Evening).mp3").timePeriod).toBe("evening");
  });

  it("should read a session marker separated by a space instead of a hyphen", () => {
    const r = parseTrackFilename("001 JKR - Title (17 April AM).mp3");

    expect(r.timePeriod).toBe("morning");
    expect(r.title).toBe("Title");
  });

  it("should not leave a trailing space when an underscore precedes an ISO date", () => {
    const r = parseTrackFilename("001_TRAD_Introdução_2017-11-14.mp3");

    expect(r.date).toBe("2017-11-14");
    expect(r.title).toBe("Introdução");
  });
});

describe("parseTrackFilename - missing parts", () => {
  it("should default to track 0 with no speaker when there is no leading number", () => {
    const r = parseTrackFilename("Intro.mp3");

    expect(r.trackNumber).toBe(0);
    expect(r.speaker).toBeNull();
    expect(r.title).toBe("Intro");
  });

  it("should leave date, period and part null when there is no session marker", () => {
    const r = parseTrackFilename("001 JKR - Title.mp3");

    expect(r.date).toBeNull();
    expect(r.timePeriod).toBeNull();
    expect(r.partNumber).toBeNull();
  });

  it("should keep a parenthetical with an unparseable date in the title", () => {
    const r = parseTrackFilename("001 JKR - Title-(Day One AM).mp3");

    expect(r.date).toBeNull();
    expect(r.title).toContain("Day One");
  });
});

describe("inferSessions - time periods", () => {
  it("should order a day's sessions morning, afternoon, evening", () => {
    const sessions = inferSessions([
      parseTrackFilename("003 JKR - C-(7 April Evening).mp3"),
      parseTrackFilename("002 JKR - B-(7 April PM).mp3"),
      parseTrackFilename("001 JKR - A-(7 April AM).mp3"),
    ]);

    expect(sessions.map((s) => s.timePeriod)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("should title an evening session 'Evening'", () => {
    const [session] = inferSessions([parseTrackFilename("001 JKR - Title-(7 April Evening).mp3")]);

    expect(session!.titleEn).toBe("April 7 - Evening");
  });
});
