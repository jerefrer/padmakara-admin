import { describe, it, expect } from "vitest";
import { toIsoSessionDate } from "../../src/services/session-dates.ts";

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
