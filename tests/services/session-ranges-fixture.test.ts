import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTrackFilename, inferSessionsWithNotes } from "../../src/services/track-parser.ts";

// tsconfig.json has no resolveJsonModule, so the fixture is read as text
// rather than imported as a JSON module.
const fixturePath = fileURLToPath(
  new URL("../fixtures/shantideva-oct-2019-filenames.json", import.meta.url),
);
const filenames: string[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("Shantideva Oct 2019 - range-based session inference", () => {
  const tracks = filenames.map(parseTrackFilename);
  const { sessions, notes } = inferSessionsWithNotes(tracks);

  it("reads all 368 files", () => {
    expect(filenames).toHaveLength(368);
  });

  it("produces 15 sessions", () => {
    expect(sessions).toHaveLength(15);
  });

  it("places every file exactly once", () => {
    const placed = sessions.flatMap((s) => s.tracks.map((t) => t.originalFilename));
    expect(placed).toHaveLength(368);
    expect(new Set(placed).size).toBe(368);
  });

  it("leaves no track unassigned", () => {
    expect(sessions.some((s) => s.titleEn === "Unassigned tracks")).toBe(false);
  });

  it("derives the expected session titles in order", () => {
    expect(sessions.map((s) => s.titleEn)).toEqual([
      "October 6 - Morning",
      "October 6 - Afternoon",
      "October 7 - Morning",
      "October 7 - Afternoon",
      "October 7 - Questao extra",
      "October 8 - Morning",
      "October 8 - Afternoon",
      "October 9 - Morning",
      "October 9 - Afternoon",
      "October 10 - Morning",
      "October 10 - Afternoon",
      "October 11 - Morning",
      "October 11 - Afternoon",
      "October 12 - Morning",
      "October 12 - Afternoon",
    ]);
  });

  it("gives the first session tracks 001-037 plus its grouped Portuguese file", () => {
    expect(sessions[0]!.tracks).toHaveLength(38);
    expect(sessions[0]!.tracks.at(-1)!.originalFilename).toBe("001-037 [TRAD] 6_10 - Manha.mp3");
  });

  it("collapses the two Parte files of 8 October afternoon into one session", () => {
    const s = sessions.find((x) => x.titleEn === "October 8 - Afternoon")!;
    const definers = s.tracks.filter((t) => t.trackRange !== null);
    expect(definers.map((t) => t.originalFilename)).toEqual([
      "129-143 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-143 [TRAD] 8_10 - Tarde Parte 2.mp3",
    ]);
    expect(s.tracks).toHaveLength(17);
  });

  it("gives the extra-question session exactly its two files", () => {
    const s = sessions.find((x) => x.titleEn === "October 7 - Questao extra")!;
    expect(s.tracks.map((t) => t.originalFilename).sort()).toEqual([
      "093 [ENG] WF - Extra question.mp3",
      "093 [TRAD] - 7_10 - Questao extra.mp3",
    ]);
  });

  it("emits no warnings", () => {
    expect(notes.filter((n) => n.severity === "warning")).toEqual([]);
  });
});
