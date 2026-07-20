import { describe, it, expect } from "vitest";
import { toIsoSessionDate, extractYear, isIsoDate } from "../../src/services/session-dates.ts";

describe("toIsoSessionDate", () => {
  it("passes an already-ISO date through unchanged", () => {
    expect(toIsoSessionDate("2019-10-06", "2019")).toBe("2019-10-06");
  });

  it("passes an already-ISO date through unchanged even with no year given", () => {
    expect(toIsoSessionDate("2019-10-06", null)).toBe("2019-10-06");
  });

  it("converts a 'Month Day' string with a year into ISO", () => {
    expect(toIsoSessionDate("October 6", "2019")).toBe("2019-10-06");
  });

  it("pads a single-digit day", () => {
    expect(toIsoSessionDate("June 6", "2026")).toBe("2026-06-06");
  });

  it("returns the raw string unchanged when the year is null", () => {
    expect(toIsoSessionDate("October 6", null)).toBe("October 6");
  });

  it("returns the raw string unchanged when it is not a recognizable shape", () => {
    expect(toIsoSessionDate("Session 1", "2019")).toBe("Session 1");
  });
});

describe("extractYear", () => {
  it("finds the year in a folder name that does not start with a date", () => {
    expect(
      extractYear("KPS WF - Shantideva's Ninth Chapter Part 3 of 3 - LISBOA - OCT_2019 [TIB+ENG+POR]"),
    ).toBe("2019");
  });

  it("finds a 20th-century year", () => {
    expect(extractYear("Teachings 1997 - Lisboa")).toBe("1997");
  });

  it("returns null when there is no plausible year", () => {
    expect(extractYear("Teachings - Lisboa")).toBeNull();
    expect(extractYear(null)).toBeNull();
  });

  it("does not read a 4-digit non-year as a year", () => {
    expect(extractYear("Track 0123")).toBeNull();
  });
});

describe("isIsoDate", () => {
  it("accepts a full ISO date and rejects anything else", () => {
    expect(isIsoDate("2019-10-06")).toBe(true);
    expect(isIsoDate("October 6")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});
