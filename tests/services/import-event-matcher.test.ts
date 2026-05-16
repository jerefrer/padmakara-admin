import { describe, it, expect } from "vitest";
import {
  parseEventCode,
  matchEventCodeTokens,
  extractFolderTitle,
} from "../../src/services/import-event-matcher.ts";

describe("parseEventCode", () => {
  it("parses YYYYMMDD_DD — a same-month range (the most common shape)", () => {
    expect(parseEventCode("20030411_13-JKR-ENS-KAR")).toEqual({
      startDate: "2003-04-11",
      endDate: "2003-04-13",
      dateConfidence: "day",
      tokens: ["JKR", "ENS", "KAR"],
    });
  });

  it("parses YYYYMMDD — a single day", () => {
    expect(parseEventCode("20030912-CNR-CFR-FAR")).toEqual({
      startDate: "2003-09-12",
      endDate: "2003-09-12",
      dateConfidence: "day",
      tokens: ["CNR", "CFR", "FAR"],
    });
  });

  it("parses YYYYMM — month only, day defaulted to 01, no end date", () => {
    expect(parseEventCode("200405-JKR-CFR-EVO")).toEqual({
      startDate: "2004-05-01",
      endDate: null,
      dateConfidence: "month",
      tokens: ["JKR", "CFR", "EVO"],
    });
  });

  it("parses YYYYMMDD_MMDD — a cross-month range", () => {
    expect(parseEventCode("20100430_0502-JKR-PWR-TRR-RP1-VAR")).toEqual({
      startDate: "2010-04-30",
      endDate: "2010-05-02",
      dateConfidence: "day",
      tokens: ["JKR", "PWR", "TRR", "RP1", "VAR"],
    });
  });

  it("parses a dashed YYYY-MM-DD date", () => {
    expect(parseEventCode("2003-06-14-JKR-PWR-ENS-KAR")).toEqual({
      startDate: "2003-06-14",
      endDate: "2003-06-14",
      dateConfidence: "day",
      tokens: ["JKR", "PWR", "ENS", "KAR"],
    });
  });

  it("parses a dashed YYYY-MM-DD_DD range", () => {
    expect(parseEventCode("2003-11-29_30-JKR-ENS-OEI")).toEqual({
      startDate: "2003-11-29",
      endDate: "2003-11-30",
      dateConfidence: "day",
      tokens: ["JKR", "ENS", "OEI"],
    });
  });

  it("parses a dashed YYYY-MM (month only)", () => {
    expect(parseEventCode("2004-04-JKR-PWR-ENS-KAR")).toEqual({
      startDate: "2004-04-01",
      endDate: null,
      dateConfidence: "month",
      tokens: ["JKR", "PWR", "ENS", "KAR"],
    });
  });

  it("tolerates spaces around the date/token separator", () => {
    expect(parseEventCode("20160621_23 - SST-ENS-HAL")).toEqual({
      startDate: "2016-06-21",
      endDate: "2016-06-23",
      dateConfidence: "day",
      tokens: ["SST", "ENS", "HAL"],
    });
  });

  it("parses a dashed date with spaced separator", () => {
    expect(parseEventCode("2008-10-20 - JKR-PWR-CFR-HRP")).toEqual({
      startDate: "2008-10-20",
      endDate: "2008-10-20",
      dateConfidence: "day",
      tokens: ["JKR", "PWR", "CFR", "HRP"],
    });
  });

  it("parses a pipe-separated multi-month span", () => {
    expect(parseEventCode("200402|03|04-JKR-PWR-ENS-CCA")).toEqual({
      startDate: "2004-02-01",
      endDate: "2004-04-01",
      dateConfidence: "month",
      tokens: ["JKR", "PWR", "ENS", "CCA"],
    });
  });

  it("treats a YYYYMM00 (unknown day) as month precision", () => {
    expect(parseEventCode("20050400-JKR-CFR-EVO")).toEqual({
      startDate: "2005-04-01",
      endDate: null,
      dateConfidence: "month",
      tokens: ["JKR", "CFR", "EVO"],
    });
  });

  it("returns no date but keeps tokens for an undecodable date prefix", () => {
    expect(parseEventCode("2012706_08-JKR-PWR-TRR")).toEqual({
      startDate: null,
      endDate: null,
      dateConfidence: "none",
      tokens: ["JKR", "PWR", "TRR"],
    });
  });

  it("rejects an out-of-range month", () => {
    expect(parseEventCode("202523_24-JKR-PP2-CCA")).toEqual({
      startDate: null,
      endDate: null,
      dateConfidence: "none",
      tokens: ["JKR", "PP2", "CCA"],
    });
  });

  it("returns no date and all chunks as tokens for a placeholder code", () => {
    expect(parseEventCode("YYYYMMDD-VAR-CHA-PAD")).toEqual({
      startDate: null,
      endDate: null,
      dateConfidence: "none",
      tokens: ["YYYYMMDD", "VAR", "CHA", "PAD"],
    });
  });

  it("upper-cases tokens regardless of their case in the code", () => {
    expect(parseEventCode("20030912-cnr-cfr").tokens).toEqual(["CNR", "CFR"]);
  });
});

describe("matchEventCodeTokens", () => {
  const lookups = {
    teachers: [
      { id: 1, abbreviation: "JKR" },
      { id: 2, abbreviation: "DKR" },
    ],
    eventTypes: [
      { id: 10, abbreviation: "RET" },
      { id: 11, abbreviation: "PP" },
    ],
    groups: [
      { id: 20, abbreviation: "TM1" },
      { id: 21, abbreviation: "TM2" },
    ],
    places: [
      { id: 30, abbreviation: "CCA" },
      { id: 31, abbreviation: "DDL" },
    ],
    audiences: [
      { id: 40, nameEn: "Retreat group members" },
      { id: 41, nameEn: "Free for anyone" },
    ],
  };

  it("routes a teacher/group/place and infers Parallel Retreats from the group", () => {
    expect(matchEventCodeTokens(["JKR", "TM1", "CCA"], lookups)).toEqual({
      teacherIds: [1],
      groupIds: [20],
      placeIds: [30],
      eventTypeId: 10, // inferred "RET" because a group matched
      audienceId: 40, // parallel retreat → retreat-group members
    });
  });

  it("matches an explicit event type and multiple teachers (no group → no inference)", () => {
    expect(matchEventCodeTokens(["JKR", "DKR", "PP"], lookups)).toEqual({
      teacherIds: [1, 2],
      groupIds: [],
      placeIds: [],
      eventTypeId: 11,
      audienceId: null,
    });
  });

  it("is case-insensitive and ignores tokens that match nothing", () => {
    expect(matchEventCodeTokens(["jkr", "ZZZ"], lookups)).toEqual({
      teacherIds: [1],
      groupIds: [],
      placeIds: [],
      eventTypeId: null,
      audienceId: null,
    });
  });

  it("keeps only the first event type, and defaults the audience for RET", () => {
    expect(matchEventCodeTokens(["RET", "PP"], lookups)).toEqual({
      teacherIds: [],
      groupIds: [],
      placeIds: [],
      eventTypeId: 10,
      audienceId: 40,
    });
  });

  it("infers Parallel Retreats from a lone parallel-retreat group marker (TM1)", () => {
    expect(matchEventCodeTokens(["TM1"], lookups)).toEqual({
      teacherIds: [],
      groupIds: [20],
      placeIds: [],
      eventTypeId: 10,
      audienceId: 40,
    });
  });

  it("does not override an explicit non-RET event type when a group is present", () => {
    expect(matchEventCodeTokens(["TM1", "PP"], lookups)).toEqual({
      teacherIds: [],
      groupIds: [20],
      placeIds: [],
      eventTypeId: 11,
      audienceId: null,
    });
  });

  it("does not infer a parallel retreat when there is no RET event type", () => {
    expect(
      matchEventCodeTokens(["TM1"], {
        teachers: [],
        eventTypes: [{ id: 11, abbreviation: "PP" }],
        groups: [{ id: 20, abbreviation: "TM1" }],
        places: [],
        audiences: [{ id: 40, nameEn: "Retreat group members" }],
      }),
    ).toEqual({
      teacherIds: [],
      groupIds: [20],
      placeIds: [],
      eventTypeId: null,
      audienceId: null,
    });
  });

  it("ignores entities whose abbreviation is null", () => {
    expect(
      matchEventCodeTokens(["JKR"], {
        teachers: [{ id: 1, abbreviation: "JKR" }],
        eventTypes: [{ id: 9, abbreviation: null }],
        groups: [],
        places: [],
        audiences: [],
      }),
    ).toEqual({
      teacherIds: [1],
      groupIds: [],
      placeIds: [],
      eventTypeId: null,
      audienceId: null,
    });
  });
});

describe("extractFolderTitle", () => {
  it("extracts a parenthetical title from a folder name", () => {
    expect(
      extractFolderTitle("mediateca/2004-02:03:04-JKR-PWR-ENS-CCA (Amala Parinirvana)/"),
    ).toBe("Amala Parinirvana");
  });

  it("extracts a one-word parenthetical hint", () => {
    expect(extractFolderTitle("mediateca/2006-07-00-JKR-CFR-UBP (Porto)/")).toBe(
      "Porto",
    );
  });

  it("returns null when the folder name has no parenthetical", () => {
    expect(extractFolderTitle("mediateca/2003-06-14-JKR-PWR-ENS-KAR/")).toBeNull();
  });

  it("returns null for an empty parenthetical", () => {
    expect(extractFolderTitle("something ()")).toBeNull();
  });
});
