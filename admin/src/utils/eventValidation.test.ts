import { describe, expect, it } from "vitest";
import { validateImportEvent } from "./eventValidation";

const VALID = {
  eventCode: "20260910_12-JKR-TM1-ZOOM",
  titleEn: "37 Practices of a Bodhisattva",
  startDate: "2026-09-10",
  endDate: "2026-09-12",
  eventTypeSelected: true,
  audienceSelected: true,
  teacherCount: 1,
  placeCount: 1,
  sessions: [],
};

describe("validateImportEvent", () => {
  it("should accept a complete event", () => {
    expect(validateImportEvent(VALID)).toEqual([]);
  });

  it("should refuse a parallel retreat without a user group", () => {
    expect(validateImportEvent({ ...VALID, groupsRequired: true, groupCount: 0 })).toEqual([
      "Parallel retreats need at least one user group",
    ]);
  });

  it("should accept a parallel retreat with a user group", () => {
    expect(validateImportEvent({ ...VALID, groupsRequired: true, groupCount: 2 })).toEqual([]);
  });

  it("should not ask for a user group on other event types", () => {
    expect(validateImportEvent({ ...VALID, groupsRequired: false, groupCount: 0 })).toEqual([]);
  });
});
