import { describe, it, expect } from "vitest";
import { parseTrackFilename } from "../../src/services/track-parser.ts";
import { hasTrackRanges, inferSessionsFromRanges } from "../../src/services/session-ranges.ts";

const parse = (names: string[]) => names.map(parseTrackFilename);

describe("hasTrackRanges", () => {
  it("is true when any track carries an explicit range", () => {
    expect(hasTrackRanges(parse(["001-037 [TRAD] 6_10 - Manha.mp3"]))).toBe(true);
  });

  it("is false for ordinary tracks", () => {
    expect(hasTrackRanges(parse(["001 JKR - Track-(17 April AM).mp3"]))).toBe(false);
  });
});

describe("inferSessionsFromRanges", () => {
  it("assigns individual tracks to the range that contains them", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "003-004 [TRAD] 6_10 - Tarde.mp3",
      "001 [TIB] Prayers.mp3",
      "002 [ENG] Teaching.mp3",
      "003 [TIB] Afternoon prayers.mp3",
      "004 [ENG] Afternoon teaching.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.titleEn).toBe("October 6 - Morning");
    expect(sessions[0]!.tracks.map((t) => t.originalFilename)).toEqual([
      "001 [TIB] Prayers.mp3",
      "002 [ENG] Teaching.mp3",
      "001-002 [TRAD] 6_10 - Manha.mp3",
    ]);
    expect(sessions[1]!.titleEn).toBe("October 6 - Afternoon");
    expect(sessions[1]!.tracks).toHaveLength(3);
  });

  it("collapses two files sharing one range into a single session, ordered by part", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "129-130 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 2.mp3",
      "129 [ENG] Teaching.mp3",
      "130 [ENG] Questions.mp3",
    ]));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks.map((t) => t.originalFilename)).toEqual([
      "129 [ENG] Teaching.mp3",
      "130 [ENG] Questions.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 2.mp3",
    ]);
  });

  it("promotes a dated track outside every range into its own session", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 7_10 - Tarde.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
      "003 [TRAD] - 7_10 - Questao extra.mp3",
      "003 [ENG] WF - Extra question.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.titleEn).toBe("October 7 - Questao extra");
    expect(sessions[1]!.tracks.map((t) => t.originalFilename)).toEqual([
      "003 [ENG] WF - Extra question.mp3",
      "003 [TRAD] - 7_10 - Questao extra.mp3",
    ]);
  });

  it("puts uncovered tracks in a trailing session and warns", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "009 [ENG] Orphan.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.titleEn).toBe("Unassigned tracks");
    expect(sessions[1]!.tracks.map((t) => t.originalFilename)).toEqual(["009 [ENG] Orphan.mp3"]);
    const warning = notes.find((n) => n.severity === "warning");
    expect(warning?.message).toContain("009 [ENG] Orphan.mp3");
  });

  it("assigns an overlapped track to the narrower range and warns", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-010 [TRAD] 6_10 - Manha.mp3",
      "005-006 [TRAD] 6_10 - Tarde.mp3",
      "005 [ENG] Contested.mp3",
    ]));

    const narrow = sessions.find((s) => s.titleEn === "October 6 - Afternoon");
    expect(narrow!.tracks.map((t) => t.originalFilename)).toContain("005 [ENG] Contested.mp3");
    expect(notes.some((n) => n.severity === "warning" && n.message.includes("overlap"))).toBe(true);
  });

  it("notes a range with no individual tracks but still creates its session", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
    ]));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks).toHaveLength(1);
    expect(notes.some((n) => n.severity === "info")).toBe(true);
  });
});

import { inferSessions, inferSessionsWithNotes } from "../../src/services/track-parser.ts";

describe("inferSessions activation gate", () => {
  it("uses range mode when a range is present", () => {
    const sessions = inferSessions(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.titleEn).toBe("October 6 - Morning");
  });

  it("falls back to date grouping when no range is present", () => {
    const sessions = inferSessions(parse([
      "001 JKR - Track 1-(17 April AM).mp3",
      "002 JKR - Track 2-(17 April AM).mp3",
      "003 JKR - Track 3-(17 April PM).mp3",
    ]));
    expect(sessions).toHaveLength(2);
  });

  it("returns no notes in date mode", () => {
    const { notes } = inferSessionsWithNotes(parse([
      "001 JKR - Track 1-(17 April AM).mp3",
    ]));
    expect(notes).toEqual([]);
  });
});

describe("translation correction", () => {
  it("keeps isTranslation true on an English track in a session that also has Tibetan", () => {
    const { sessions } = inferSessionsWithNotes(parse([
      "01 KPS [TIB] Prayer 2017-11-14.mp3",
      "02 KPS [ENG] Prayer translation 2017-11-14.mp3",
    ]));
    expect(sessions).toHaveLength(1);
    const eng = sessions[0]!.tracks.find((t) => t.languages[0] === "en")!;
    expect(eng.isTranslation).toBe(true);
  });

  it("clears isTranslation on English tracks in a session with no Tibetan", () => {
    const { sessions } = inferSessionsWithNotes(parse([
      "01 KPS [ENG] Teaching 2017-11-14.mp3",
      "02 KPS [ENG] More teaching 2017-11-14.mp3",
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks.every((t) => t.isTranslation === false)).toBe(true);
  });

  it("keeps a [TRAD] Portuguese range definer flagged as a translation even with no Tibetan in its session", () => {
    const { sessions } = inferSessionsWithNotes(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
    ]));
    expect(sessions).toHaveLength(1);
    const trad = sessions[0]!.tracks.find((t) => t.trackRange !== null)!;
    expect(trad.languages).toEqual(["pt"]);
    expect(trad.isTranslation).toBe(true);
    // The session has no Tibetan track, so the ENG tracks in it are corrected.
    expect(sessions[0]!.tracks.filter((t) => t.languages[0] === "en").every((t) => !t.isTranslation)).toBe(true);
  });
});
