import { describe, it, expect } from "vitest";
import {
  parseTrackFile, parseFolderName, inferSessions, resolveSessionDates, toIsoSessionDate,
  isMediaFilename, isJunkFilename, isJunkDirName,
} from "../../admin/src/utils/trackParser.ts";
import { parseTrackFilename } from "../../src/services/track-parser.ts";

/** Build a File whose only meaningful property here is its name. */
function fileFor(name: string): File {
  return new File([""], name, { type: "audio/mpeg" });
}

describe("admin parseTrackFile", () => {
  describe("track number extraction", () => {
    it("reads a hyphen-separated track number (regression: was 0)", () => {
      const result = parseTrackFile(fileFor("07-KNP-[TIB+PT] Oracoes Iniciais (11 June PM).mp3"));
      expect(result.trackNumber).toBe(7);
    });

    it("reads the full dropped folder set with correct numbers", () => {
      const names = [
        "01-DLP-Oracoes iniciais (10 June PM).mp3",
        "02-DLP-Linhagem Kyentse (10 June PM).mp3",
        "07-KNP-[TIB+PT]Oracoes Iniciais (11 June PM).mp3",
        "08-KNP-O Sutra (11 June PM).mp3",
        "09-KNP-Oracao pela Linhagem (11 June PM).mp3",
      ];
      const numbers = names.map((n) => parseTrackFile(fileFor(n)).trackNumber);
      expect(numbers).toEqual([1, 2, 7, 8, 9]);
    });

    it("still reads space- and underscore-separated numbers", () => {
      expect(parseTrackFile(fileFor("001 JKR - Teaching.mp3")).trackNumber).toBe(1);
      expect(parseTrackFile(fileFor("02_KPS [ENG] Intro.mp3")).trackNumber).toBe(2);
    });

    it("does not treat a YYYYMMDD prefix as a track number", () => {
      const result = parseTrackFile(fileFor("20250810-PART_1 [ENG].mp3"));
      expect(result.trackNumber).toBe(0);
      expect(result.date).toBe("2025-08-10");
    });
  });

  describe("session date marker formats", () => {
    const base = "01-KNP-[TIB+PT] Oracoes Iniciais";
    const cases: Array<[string, string]> = [
      ["day month", `${base} (11 June PM).mp3`],
      ["day month with ordinal", `${base} (11th June PM).mp3`],
      ["month day", `${base} (June 11 PM).mp3`],
      ["month day with ordinal", `${base} (June 11th PM).mp3`],
      ["numeric slash", `${base} (11/06 PM).mp3`],
      ["numeric hyphen", `${base} (11-06 PM).mp3`],
    ];

    for (const [label, filename] of cases) {
      it(`parses ${label} → "June 11" afternoon`, () => {
        const result = parseTrackFile(fileFor(filename));
        expect(result.date).toBe("June 11");
        expect(result.timePeriod).toBe("afternoon");
        expect(result.title).toBe("Oracoes Iniciais");
      });
    }

    it("parses numeric slash with year → ISO date", () => {
      const result = parseTrackFile(fileFor(`${base} (11/06/2026 PM).mp3`));
      expect(result.date).toBe("2026-06-11");
      expect(result.title).toBe("Oracoes Iniciais");
    });

    it("parses numeric hyphen with year → ISO date", () => {
      const result = parseTrackFile(fileFor(`${base} (11-06-2026 PM).mp3`));
      expect(result.date).toBe("2026-06-11");
      expect(result.title).toBe("Oracoes Iniciais");
    });

    it("reads AM as morning", () => {
      expect(parseTrackFile(fileFor(`${base} (June 11 AM).mp3`)).timePeriod).toBe("morning");
    });
  });
});

describe("infer-sessions track partitioning", () => {
  it("keeps range definers in session inference, not the translations bucket", () => {
    // Deliberately untagged (not "[ENG]"): a solo non-Tibetan bracket tag is
    // itself classified isTranslation:true (pre-existing behaviour, unrelated
    // to ranges — a lone [ENG]/[POR] track is treated as a translation of a
    // Tibetan original), which would confound this fixture's two buckets.
    const filenames = [
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 KPS Teaching.mp3",
      "002 KPS Questions.mp3",
      "001 TRAD - Ensinamento.mp3",
    ];
    const tracks = filenames.map(parseTrackFilename);
    const forSessions = tracks.filter((t) => !t.isTranslation || t.trackRange !== null);
    const translations = tracks.filter((t) => t.isTranslation && t.trackRange === null);

    expect(forSessions.map((t) => t.originalFilename)).toContain("001-002 [TRAD] 6_10 - Manha.mp3");
    expect(translations.map((t) => t.originalFilename)).toEqual(["001 TRAD - Ensinamento.mp3"]);
    expect(forSessions.length + translations.length).toBe(tracks.length);
  });
});

describe("folder with day-month markers and no year (Guru Yoga 20250426_27)", () => {
  const folder = "20250426_27-JKR-Guru Yoga [ING+POR]";
  const jkr = (n: string, title: string, marker: string) => `${n} JKR - ${title}-(${marker}).mp3`;
  const names = [
    jkr("001", "Intitial prayers", "26 April AM_part_1"),
    "001 TRAD - Oracoes iniciais.mp3",
    jkr("006", "The quintessence of the path", "26 April AM_part_2"),
    "006 TRAD - A quintessencia do caminho.mp3",
    jkr("011", "Question about pure perception", "26 April PM"),
    "011 TRAD - Questao sobre percepcao pura.mp3",
    jkr("017", "Initial prayers", "27 April AM"),
    "017 TRAD - Oracoes iniciais.mp3",
    jkr("021", "Brief preliminary practice", "27 April PM"),
    "021 TRAD - Breves praticas preliminares.mp3",
  ];

  it("splits sessions by date, period and AM part, pairing TRAD tracks by number", () => {
    const sessions = inferSessions(names.map((n) => parseTrackFile(fileFor(n))));
    expect(sessions.map((s) => [s.date, s.timePeriod, s.tracks.map((t) => t.trackNumber)])).toEqual([
      ["April 26", "morning", [1, 1]],
      ["April 26", "morning", [6, 6]],
      ["April 26", "afternoon", [11, 11]],
      ["April 27", "morning", [17, 17]],
      ["April 27", "afternoon", [21, 21]],
    ]);
    expect(sessions.map((s) => s.tracks.filter((t) => t.isTranslation).length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("takes the missing year from the folder date and never yields a non-ISO date", () => {
    const meta = parseFolderName(folder);
    const sessions = resolveSessionDates(
      inferSessions(names.map((n) => parseTrackFile(fileFor(n)))),
      meta.startDate!.slice(0, 4),
    );
    expect(sessions.map((s) => s.date)).toEqual([
      "2025-04-26", "2025-04-26", "2025-04-26", "2025-04-27", "2025-04-27",
    ]);
  });

  it("leaves sessions undated when no year is known instead of sending 'April 26'", () => {
    const sessions = resolveSessionDates(
      inferSessions(names.map((n) => parseTrackFile(fileFor(n)))),
      null,
    );
    for (const s of sessions) expect(s.date).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(toIsoSessionDate("February 30", "2025")).toBeNull();
    expect(toIsoSessionDate("garbage", "2025")).toBeNull();
    expect(toIsoSessionDate("2025-13-01", "2025")).toBeNull();
    expect(toIsoSessionDate("June 11", "2025")).toBe("2025-06-11");
  });
});

describe("parseFolderName date forms", () => {
  const cases: Array<[string, string, string]> = [
    ["20250426_27-JKR-Guru Yoga [ING+POR]", "2025-04-26", "2025-04-27"],
    ["20250426-JKR-Guru Yoga", "2025-04-26", "2025-04-26"],
    ["2025-04-26_27-JKR-Guru Yoga [ING+POR]", "2025-04-26", "2025-04-27"],
    ["2025-04-26-JKR-Guru Yoga", "2025-04-26", "2025-04-26"],
    ["2025.04.12-13-JKR-Guru Yoga", "2025-04-12", "2025-04-13"],
  ];
  for (const [name, start, end] of cases) {
    it(`parses "${name}"`, () => {
      const meta = parseFolderName(name);
      expect(meta.startDate).toBe(start);
      expect(meta.endDate).toBe(end);
      expect(meta.teacherAbbrev).toBe("JKR");
      expect(meta.groupSlug).toBe("Guru Yoga");
    });
  }
});

describe("archive junk filtering", () => {
  it("does not treat AppleDouble, .DS_Store or __MACOSX as media", () => {
    expect(isMediaFilename("._001 JKR - Intitial prayers-(26 April AM_part_1).mp3")).toBe(false);
    expect(isMediaFilename(".DS_Store")).toBe(false);
    expect(isMediaFilename("001 TRAD - Oracoes iniciais.mp3")).toBe(true);
    expect(isJunkDirName("__MACOSX")).toBe(true);
    expect(isJunkFilename("._x")).toBe(true);
  });
});
