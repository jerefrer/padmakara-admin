import { describe, it, expect } from "vitest";
import {
  aiGroupingSchema,
  assembleProposedStructure,
  type ProposedTrack,
} from "../../src/services/import-inference.ts";

function track(importFileId: number, trackNumber: number): ProposedTrack {
  return {
    importFileId,
    trackNumber,
    title: `Track ${trackNumber}`,
    speaker: "JKR",
    languages: ["en"],
    originalLanguage: "en",
    isTranslation: false,
  };
}

describe("aiGroupingSchema", () => {
  it("accepts a valid grouping", () => {
    const parsed = aiGroupingSchema.parse({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Morning",
          sessionDate: "2024-04-25",
          timePeriod: "morning",
          importFileIds: [1, 2],
        },
      ],
    });
    expect(parsed.sessions).toHaveLength(1);
  });

  it("rejects an invalid time period", () => {
    expect(() =>
      aiGroupingSchema.parse({
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "all-day",
            importFileIds: [1],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a session with no files", () => {
    expect(() =>
      aiGroupingSchema.parse({
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            importFileIds: [],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("assembleProposedStructure", () => {
  it("builds a structure and renumbers sessions 1..N in array order", () => {
    const map = new Map<number, ProposedTrack>([
      [10, track(10, 1)],
      [11, track(11, 2)],
      [12, track(12, 3)],
    ]);
    const structure = assembleProposedStructure(
      {
        sessions: [
          {
            sessionNumber: 5,
            titleEn: "Afternoon",
            sessionDate: "2024-04-25",
            timePeriod: "afternoon",
            importFileIds: [12],
          },
          {
            sessionNumber: 9,
            titleEn: "Morning",
            sessionDate: "2024-04-25",
            timePeriod: "morning",
            importFileIds: [10, 11],
          },
        ],
      },
      map,
    );
    expect(structure.sessions).toHaveLength(2);
    expect(structure.sessions[0]?.sessionNumber).toBe(1);
    expect(structure.sessions[1]?.sessionNumber).toBe(2);
    expect(structure.sessions[1]?.tracks.map((t) => t.importFileId)).toEqual([
      10, 11,
    ]);
  });

  it("defaults a null timePeriod to morning", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    const structure = assembleProposedStructure(
      {
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: null,
            importFileIds: [1],
          },
        ],
      },
      map,
    );
    expect(structure.sessions[0]?.timePeriod).toBe("morning");
  });

  it("throws when the grouping references an unknown file", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    expect(() =>
      assembleProposedStructure(
        {
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "X",
              sessionDate: null,
              timePeriod: "morning",
              importFileIds: [1, 99],
            },
          ],
        },
        map,
      ),
    ).toThrow(/unknown import file id 99/);
  });

  it("throws when a file is placed in two sessions", () => {
    const map = new Map<number, ProposedTrack>([
      [1, track(1, 1)],
      [2, track(2, 2)],
    ]);
    expect(() =>
      assembleProposedStructure(
        {
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "A",
              sessionDate: null,
              timePeriod: "morning",
              importFileIds: [1],
            },
            {
              sessionNumber: 2,
              titleEn: "B",
              sessionDate: null,
              timePeriod: "morning",
              importFileIds: [1, 2],
            },
          ],
        },
        map,
      ),
    ).toThrow(/more than one session/);
  });

  it("throws when a file is omitted from the grouping", () => {
    const map = new Map<number, ProposedTrack>([
      [1, track(1, 1)],
      [2, track(2, 2)],
    ]);
    expect(() =>
      assembleProposedStructure(
        {
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "X",
              sessionDate: null,
              timePeriod: "morning",
              importFileIds: [1],
            },
          ],
        },
        map,
      ),
    ).toThrow(/omits import file id 2/);
  });
});
