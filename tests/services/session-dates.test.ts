import { describe, it, expect } from "vitest";
import {
  parseSessionDateToken,
  formatSessionDate,
  normalizePeriod,
  extractBareSessionDate,
} from "../../src/services/session-dates.ts";

describe("parseSessionDateToken", () => {
  it("parses underscore-separated numeric dates day-first", () => {
    expect(parseSessionDateToken("6_10")).toEqual({ month: "October", day: 6, year: null });
  });

  it("still parses slash and hyphen numeric dates day-first", () => {
    expect(parseSessionDateToken("11/06")).toEqual({ month: "June", day: 11, year: null });
    expect(parseSessionDateToken("11-06-2026")).toEqual({ month: "June", day: 11, year: 2026 });
  });

  it("rejects an impossible month", () => {
    expect(parseSessionDateToken("11_14")).toBeNull();
  });

  it("parses day-then-month-name", () => {
    expect(parseSessionDateToken("17 April")).toEqual({ month: "April", day: 17, year: null });
  });
});

describe("formatSessionDate", () => {
  it("returns ISO when a year is known", () => {
    expect(formatSessionDate({ month: "June", day: 11, year: 2026 })).toBe("2026-06-11");
  });

  it("returns month and day when the year is unknown", () => {
    expect(formatSessionDate({ month: "October", day: 6, year: null })).toBe("October 6");
  });
});

describe("normalizePeriod", () => {
  it("maps English and Portuguese period words", () => {
    expect(normalizePeriod("AM")).toBe("morning");
    expect(normalizePeriod("Manha")).toBe("morning");
    expect(normalizePeriod("manhã")).toBe("morning");
    expect(normalizePeriod("PM")).toBe("afternoon");
    expect(normalizePeriod("Tarde")).toBe("afternoon");
    expect(normalizePeriod("tarde")).toBe("afternoon");
    expect(normalizePeriod("Noite")).toBe("evening");
  });

  it("returns null for a non-period word", () => {
    expect(normalizePeriod("Questao")).toBeNull();
  });
});

describe("extractBareSessionDate", () => {
  it("extracts a date and the descriptive text that follows it", () => {
    expect(extractBareSessionDate("093 [TRAD] - 7_10 - Questao extra.mp3")).toEqual({
      date: "October 7",
      descriptor: "Questao extra",
    });
  });

  it("ignores filenames carrying a full ISO date", () => {
    expect(extractBareSessionDate("01 KPS [TIB] Prayer 2017-11-12.mp3")).toBeNull();
  });

  it("ignores filenames carrying a compact date", () => {
    expect(extractBareSessionDate("01-TPWR-20030614-KAR.mp3")).toBeNull();
  });

  it("returns null when there is no date at all", () => {
    expect(extractBareSessionDate("001 [TIB] Openning prayers.mp3")).toBeNull();
  });
});
