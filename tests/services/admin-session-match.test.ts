import { describe, it, expect } from "vitest";
import { findMatchingExistingSession } from "../../admin/src/utils/sessionMatch.ts";

const toIso = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
const existing = [
  { id: 1, date: "2026-10-10", timePeriod: "morning" },
  { id: 2, date: "2026-10-10", timePeriod: "afternoon" },
];

describe("findMatchingExistingSession", () => {
  it("should return the session with the same date and period", () => {
    const found = findMatchingExistingSession(existing, { date: "2026-10-10", timePeriod: "afternoon" }, toIso);
    expect(found?.id).toBe(2);
  });

  it("should return undefined when the period differs", () => {
    expect(
      findMatchingExistingSession(existing, { date: "2026-10-10", timePeriod: "evening" }, toIso),
    ).toBeUndefined();
  });

  it("should return undefined when the incoming session has no period", () => {
    expect(
      findMatchingExistingSession(existing, { date: "2026-10-10", timePeriod: null }, toIso),
    ).toBeUndefined();
  });
});
