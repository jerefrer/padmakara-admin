import { describe, it, expect } from "vitest";
import { parseTrackFile } from "../../admin/src/utils/trackParser.ts";

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
