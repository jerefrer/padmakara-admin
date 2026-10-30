import { describe, it, expect } from "vitest";
import { moveTracksToSession, nextSessionNumber } from "../../admin/src/utils/moveTracks.ts";
import type { InferredSession, ParsedTrack } from "../../admin/src/utils/trackParser.ts";

function track(id: number, trackNumber: number, isTranslation = false): ParsedTrack {
  return { id, trackNumber, isTranslation } as ParsedTrack;
}

function session(id: number, sessionNumber: number, period: string, tracks: ParsedTrack[]): InferredSession {
  return { id, sessionNumber, date: "2026-10-10", timePeriod: period, tracks } as InferredSession;
}

describe("moveTracksToSession", () => {
  const sessions = [
    session(1, 1, "morning", [track(10, 1), track(11, 2), track(12, 3)]),
    session(2, 2, "afternoon", [track(20, 1)]),
  ];

  it("should move the selected tracks into the target session", () => {
    const next = moveTracksToSession(sessions, new Set([11, 12]), 2);
    expect(next[0]!.tracks.map((t) => t.id)).toEqual([10]);
    expect(next[1]!.tracks.map((t) => t.id)).toEqual([20, 11, 12]);
  });

  it("should give moved tracks the target's period", () => {
    const next = moveTracksToSession(sessions, new Set([10]), 2);
    expect(next[1]!.tracks.find((t) => t.id === 10)!.timePeriod).toBe("afternoon");
  });

  it("should keep an emptied session in place", () => {
    const next = moveTracksToSession(sessions, new Set([20]), 1);
    expect(next[1]!.tracks).toEqual([]);
    expect(next).toHaveLength(2);
  });

  it("should leave sessions untouched when the target does not exist", () => {
    expect(moveTracksToSession(sessions, new Set([10]), 99)).toBe(sessions);
  });
});

describe("nextSessionNumber", () => {
  it("should be one past the highest session number", () => {
    expect(nextSessionNumber([{ sessionNumber: 1 }, { sessionNumber: 4 }])).toBe(5);
  });

  it("should start at 1 when there are no sessions", () => {
    expect(nextSessionNumber([])).toBe(1);
  });
});
