import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.ts", () => ({ db: { query: { events: { findFirst: vi.fn() } } } }));

import { matchSession, defaultSlideLanguage } from "../../src/services/slide-metadata.ts";

const FOUR_DAYS = [
  { sessionNumber: 1, sessionDate: "2026-10-10", timePeriod: "morning" },
  { sessionNumber: 2, sessionDate: "2026-10-11", timePeriod: "morning" },
  { sessionNumber: 3, sessionDate: "2026-10-12", timePeriod: "evening" },
  { sessionNumber: 4, sessionDate: "2026-10-13", timePeriod: "morning" },
];

describe("matchSession", () => {
  it("finds the one session on the video's date", () => {
    expect(matchSession(FOUR_DAYS, "2026-10-12")).toEqual({
      number: 3,
      total: 4,
      date: "2026-10-12",
      period: "evening",
    });
  });

  it("numbers sessions by their order, not by their stored number", () => {
    const gappy = [
      { sessionNumber: 5, sessionDate: "2026-10-10", timePeriod: "morning" },
      { sessionNumber: 9, sessionDate: "2026-10-11", timePeriod: "morning" },
    ];
    expect(matchSession(gappy, "2026-10-11")).toMatchObject({ number: 2, total: 2 });
  });

  it("returns null when two sessions share the date", () => {
    const sameDay = [
      { sessionNumber: 1, sessionDate: "2026-10-10", timePeriod: "morning" },
      { sessionNumber: 2, sessionDate: "2026-10-10", timePeriod: "evening" },
    ];
    expect(matchSession(sameDay, "2026-10-10")).toBeNull();
  });

  it("returns null when no session falls on the date", () => {
    expect(matchSession(FOUR_DAYS, "2026-11-01")).toBeNull();
  });

  it("returns null without a date", () => {
    expect(matchSession(FOUR_DAYS, null)).toBeNull();
  });

  it("returns null for an event with a single session", () => {
    expect(matchSession([FOUR_DAYS[0]!], "2026-10-10")).toBeNull();
  });
});

describe("defaultSlideLanguage", () => {
  it.each([
    ["en", "en"],
    ["pt", "pt"],
    ["tib", "en"],
    [null, "en"],
  ])("maps %j to %s", (input, expected) => {
    expect(defaultSlideLanguage(input)).toBe(expected);
  });
});
