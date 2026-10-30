import { describe, it, expect } from "vitest";
import { parseTrackFilename, inferSessions } from "../../src/services/track-parser.ts";
import { parseTrackFile, inferSessions as inferSessionsAdmin } from "../../admin/src/utils/trackParser.ts";

const DAY1 = [
  "Learning to Let Go - 10th October 2026 - Morning Part 1.mp3",
  "Learning to Let Go - 10th October 2026 - TRAD - A Importancia do Desapego - Manha_Parte_1.mp3",
  "Learning to Let Go - 10th October 2026 - Morning Part 2.mp3",
  "Learning to Let Go - 10th October 2026 - TRAD - A Importancia do Desapego - Manha_Parte_2.mp3",
  "Learning to Let Go - 10th October 2026 - Afternoon Part 1.mp3",
  "Learning to Let Go - 10th October 2026 - TRAD - A Importancia do Desapego - Tarde_Parte_1.mp3",
  "Learning to Let Go - 10th October 2026 - Afternoon Part 2.mp3",
  "Learning to Let Go - 10th October 2026 - TRAD - A Importancia do Desapego - Tarde_Parte_2.mp3",
];
const DAY2 = [
  "Learning to Let Go - 11th October 2026 - JKR - Learning to Let Go - Morning.mp3",
  "Learning to Let Go - 11th October 2026 - TRAD - A Importancia do Desapego - Manha.mp3",
  "Learning to Let Go - 11th October 2026 - JKR - Learning to Let Go - Afternoon_Part_1.mp3",
  "Learning to Let Go - 11th October 2026 - TRAD - A Importancia do Desapego - Tarde_Parte_1.mp3",
  "Learning to Let Go - 11th October 2026 - JKR - Learning to Let Go - Afternoon_Part_2.mp3",
  "Learning to Let Go - 11th October 2026 - TRAD - A Importancia do Desapego - Tarde_Parte_2.mp3",
];

describe("period words in filenames", () => {
  it.each([
    ["Talk - Morning", "morning"],
    ["Talk - MANHÃ", "morning"],
    ["Talk - manha", "morning"],
    ["Talk - Matin", "morning"],
    ["Talk - Afternoon", "afternoon"],
    ["Talk - Tarde", "afternoon"],
    ["Talk - Après-midi", "afternoon"],
    ["Talk - Apres_midi", "afternoon"],
    ["Talk - Evening", "evening"],
    ["Talk - Night", "evening"],
    ["Talk - Noite", "evening"],
    ["Talk - Soir", "evening"],
    ["Talk - Soirée", "evening"],
  ])("should read the period of %s when it ends the name", (name, period) => {
    expect(parseTrackFilename(`${name}.mp3`).timePeriod).toBe(period);
  });

  it("should read the part number from Part, Parte and Pt forms", () => {
    expect(parseTrackFilename("T - Morning Part 1.mp3").sessionPart).toBe(1);
    expect(parseTrackFilename("T - Tarde_Parte_2.mp3").sessionPart).toBe(2);
    expect(parseTrackFilename("T - Afternoon_Part_3.mp3").sessionPart).toBe(3);
    expect(parseTrackFilename("T - Morning Pt 2.mp3").sessionPart).toBe(2);
  });

  it("should leave a title that only contains a period word untouched", () => {
    const parsed = parseTrackFilename("001 JKR - Morning prayers 2025-04-17.mp3");
    expect(parsed.timePeriod).toBeNull();
  });

  it("should read a spelled-out date next to a period word", () => {
    expect(parseTrackFilename(DAY1[0]!).date).toBe("2026-10-10");
  });
});

describe("inferSessions with period words", () => {
  it("should group the two-day example into four sessions", () => {
    const tracks = [...DAY1, ...DAY2].map(parseTrackFilename);
    const sessions = inferSessions(tracks);
    expect(sessions.map((s) => [s.date, s.timePeriod, s.tracks.length])).toEqual([
      ["2026-10-10", "morning", 4],
      ["2026-10-10", "afternoon", 4],
      ["2026-10-11", "morning", 2],
      ["2026-10-11", "afternoon", 4],
    ]);
  });

  it("should order tracks by part inside a session", () => {
    const sessions = inferSessions(DAY1.map(parseTrackFilename));
    expect(sessions[0]!.tracks.map((t) => [t.sessionPart, t.isTranslation])).toEqual([
      [1, false], [1, true], [2, false], [2, true],
    ]);
  });

  it("should place undated translations by period and part, keeping days apart", () => {
    const names = [
      "Talk - 10th October 2026 - Morning Part 1.mp3",
      "Talk - 10th October 2026 - Morning Part 2.mp3",
      "TRAD - Conversa - Manha_Parte_1.mp3",
      "TRAD - Conversa - Manha_Parte_2.mp3",
    ];
    const sessions = inferSessions(names.map(parseTrackFilename));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks).toHaveLength(4);
  });

  it("should group period-only tracks without a date by period", () => {
    const names = ["A - Morning Part 1.mp3", "A - Morning Part 2.mp3", "A - Afternoon.mp3"];
    const sessions = inferSessions(names.map(parseTrackFilename));
    expect(sessions.map((s) => [s.timePeriod, s.tracks.length])).toEqual([
      ["morning", 2],
      ["afternoon", 1],
    ]);
  });
});

describe("admin parser mirror", () => {
  const file = (name: string) => new File([""], name, { type: "audio/mpeg" });

  it("should group the two-day example into four sessions", () => {
    const tracks = [...DAY1, ...DAY2].map((n) => parseTrackFile(file(n)));
    const sessions = inferSessionsAdmin(tracks);
    expect(sessions.map((s) => [s.date, s.timePeriod, s.tracks.length])).toEqual([
      ["2026-10-10", "morning", 4],
      ["2026-10-10", "afternoon", 4],
      ["2026-10-11", "morning", 2],
      ["2026-10-11", "afternoon", 4],
    ]);
  });

  it("should keep dateless days apart from dated ones", () => {
    const names = [
      "Learning to Let Go - 10th October 2026 - Morning Part 1.mp3",
      "Learning to Let Go - 10th October 2026 - TRAD - A Importancia - Manha_Parte_1.mp3",
      "JKR - Learning to Let Go - Morning.mp3",
      "TRAD - A Importancia - Manha.mp3",
    ];
    const sessions = inferSessionsAdmin(names.map((n) => parseTrackFile(file(n))));
    expect(sessions.map((s) => [s.date, s.tracks.length])).toEqual([
      ["2026-10-10", 2],
      [null, 2],
    ]);
  });
});
