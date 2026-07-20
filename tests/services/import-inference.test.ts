import { describe, it, expect } from "vitest";
import {
  aiGroupingSchema,
  assembleProposedStructure,
  proposedStructureSchema,
  type ProposedTrack,
  type ProposedEvent,
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
    originalFilename: `f${importFileId}.mp3`,
  };
}

/** The event block the AI returns (text fields + dates only). */
const aiEvent = {
  titleEn: "Spring Retreat",
  titlePt: "",
  mainThemesEn: "",
  mainThemesPt: "",
  sessionThemesEn: "",
  sessionThemesPt: "",
  startDate: "2024-04-25",
  endDate: "2024-04-25",
};

/** A fully-assembled ProposedEvent (what assembleProposedStructure receives). */
function proposedEvent(): ProposedEvent {
  return {
    titleEn: "Spring Retreat",
    titlePt: "",
    mainThemesEn: "",
    mainThemesPt: "",
    sessionThemesEn: "",
    sessionThemesPt: "",
    startDate: "2024-04-25",
    endDate: "2024-04-25",
    status: "draft",
    featuredAt: null,
    eventTypeId: null,
    audienceId: null,
    teacherIds: [],
    placeIds: [],
    groupIds: [],
  };
}

describe("aiGroupingSchema", () => {
  it("accepts a valid grouping", () => {
    const parsed = aiGroupingSchema.parse({
      event: aiEvent,
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Morning",
          sessionDate: "2024-04-25",
          timePeriod: "morning",
          tracks: [
            { importFileId: 1, title: "Opening prayers" },
            { importFileId: 2, title: "Morning teaching" },
          ],
        },
      ],
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.event.titleEn).toBe("Spring Retreat");
  });

  it("rejects a grouping with no event block", () => {
    expect(() =>
      aiGroupingSchema.parse({
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 1, title: "A" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an invalid time period", () => {
    expect(() =>
      aiGroupingSchema.parse({
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "all-day",
            tracks: [{ importFileId: 1, title: "A" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects the evening time period (only morning/afternoon are used)", () => {
    expect(() =>
      aiGroupingSchema.parse({
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "evening",
            tracks: [{ importFileId: 1, title: "A" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a session with no tracks", () => {
    expect(() =>
      aiGroupingSchema.parse({
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a track with an empty title", () => {
    expect(() =>
      aiGroupingSchema.parse({
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 1, title: "" }],
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
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 5,
            titleEn: "Afternoon",
            sessionDate: "2024-04-25",
            timePeriod: "afternoon",
            tracks: [{ importFileId: 12, title: "Track 3" }],
          },
          {
            sessionNumber: 9,
            titleEn: "Morning",
            sessionDate: "2024-04-25",
            timePeriod: "morning",
            tracks: [
              { importFileId: 10, title: "Track 1" },
              { importFileId: 11, title: "Track 2" },
            ],
          },
        ],
      },
      map,
      proposedEvent(),
      [],
    );
    expect(structure.sessions).toHaveLength(2);
    expect(structure.sessions[0]?.sessionNumber).toBe(1);
    expect(structure.sessions[1]?.sessionNumber).toBe(2);
    expect(structure.sessions[1]?.tracks.map((t) => t.importFileId)).toEqual([
      10, 11,
    ]);
  });

  it("uses the AI-supplied title on the assembled track", () => {
    const map = new Map<number, ProposedTrack>([[7, track(7, 1)]]);
    const structure = assembleProposedStructure(
      {
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "Morning",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 7, title: "Cleaned Title From AI" }],
          },
        ],
      },
      map,
      proposedEvent(),
      [],
    );
    expect(structure.sessions[0]?.tracks[0]?.title).toBe(
      "Cleaned Title From AI",
    );
  });

  it("preserves originalFilename from the base track", () => {
    const map = new Map<number, ProposedTrack>([[5, track(5, 1)]]);
    const structure = assembleProposedStructure(
      {
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 5, title: "Any title" }],
          },
        ],
      },
      map,
      proposedEvent(),
      [],
    );
    expect(structure.sessions[0]?.tracks[0]?.originalFilename).toBe("f5.mp3");
  });

  it("returns an empty ignored array — a fresh proposal ignores nothing", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    const structure = assembleProposedStructure(
      {
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 1, title: "Track 1" }],
          },
        ],
      },
      map,
      proposedEvent(),
      [],
    );
    expect(structure.ignored).toEqual([]);
  });

  it("carries the event block and the transcript list it is given", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    const ev = proposedEvent();
    const transcripts = [
      { importFileId: 99, language: "pt", originalFilename: "t.pdf" },
    ];
    const structure = assembleProposedStructure(
      {
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: "morning",
            tracks: [{ importFileId: 1, title: "Track 1" }],
          },
        ],
      },
      map,
      ev,
      transcripts,
    );
    expect(structure.event).toEqual(ev);
    expect(structure.transcripts).toEqual(transcripts);
  });

  it("defaults a null timePeriod to morning", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    const structure = assembleProposedStructure(
      {
        event: aiEvent,
        sessions: [
          {
            sessionNumber: 1,
            titleEn: "X",
            sessionDate: null,
            timePeriod: null,
            tracks: [{ importFileId: 1, title: "Track 1" }],
          },
        ],
      },
      map,
      proposedEvent(),
      [],
    );
    expect(structure.sessions[0]?.timePeriod).toBe("morning");
  });

  it("throws when the grouping references an unknown file", () => {
    const map = new Map<number, ProposedTrack>([[1, track(1, 1)]]);
    expect(() =>
      assembleProposedStructure(
        {
          event: aiEvent,
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "X",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [
                { importFileId: 1, title: "Track 1" },
                { importFileId: 99, title: "Unknown" },
              ],
            },
          ],
        },
        map,
        proposedEvent(),
        [],
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
          event: aiEvent,
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "A",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [{ importFileId: 1, title: "Track 1" }],
            },
            {
              sessionNumber: 2,
              titleEn: "B",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [
                { importFileId: 1, title: "Track 1" },
                { importFileId: 2, title: "Track 2" },
              ],
            },
          ],
        },
        map,
        proposedEvent(),
        [],
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
          event: aiEvent,
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "X",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [{ importFileId: 1, title: "Track 1" }],
            },
          ],
        },
        map,
        proposedEvent(),
        [],
      ),
    ).toThrow(/omits import file id 2/);
  });
});

describe("proposedStructureSchema", () => {
  const fullTrack = {
    importFileId: 1,
    trackNumber: 1,
    title: "Track 1",
    speaker: "JKR",
    languages: ["en"],
    originalLanguage: "en",
    isTranslation: false,
    originalFilename: "f1.mp3",
  };
  const oneSession = {
    sessionNumber: 1,
    titleEn: "Morning",
    sessionDate: null,
    timePeriod: "morning",
    tracks: [fullTrack],
  };
  const event = {
    titleEn: "2025 Spring Retreat",
    titlePt: "Retiro de Primavera 2025",
    mainThemesEn: "",
    mainThemesPt: "",
    sessionThemesEn: "",
    sessionThemesPt: "",
    startDate: "2025-04-12",
    endDate: "2025-04-13",
    status: "draft",
    featuredAt: null,
    eventTypeId: null,
    audienceId: null,
    teacherIds: [],
    placeIds: [],
    groupIds: [],
  };

  it("defaults missing ignored/transcripts arrays to [] (pre-feature data)", () => {
    const parsed = proposedStructureSchema.parse({
      event,
      sessions: [oneSession],
    });
    expect(parsed.ignored).toEqual([]);
    expect(parsed.transcripts).toEqual([]);
  });

  it("rejects a structure with no event block", () => {
    expect(() =>
      proposedStructureSchema.parse({ sessions: [oneSession] }),
    ).toThrow();
  });

  it("accepts a structure with a populated ignored array", () => {
    const parsed = proposedStructureSchema.parse({
      event,
      sessions: [oneSession],
      ignored: [{ ...fullTrack, importFileId: 2, originalFilename: "f2.mp3" }],
    });
    expect(parsed.ignored).toHaveLength(1);
    expect(parsed.ignored[0]?.importFileId).toBe(2);
  });

  it("accepts a structure with transcripts", () => {
    const parsed = proposedStructureSchema.parse({
      event,
      sessions: [oneSession],
      transcripts: [
        { importFileId: 9, language: "pt", originalFilename: "t.pdf" },
      ],
    });
    expect(parsed.transcripts).toHaveLength(1);
    expect(parsed.transcripts[0]?.language).toBe("pt");
  });
});

// Sessions were arriving with an empty date: filename markers like "6_10" carry
// no year, and a folder that does not lead with a date ("KPS WF - ... - OCT_2019")
// leaves the event startDate null, so "October 6" reached a Postgres `date`
// column and was dropped.
describe("assembleProposedStructure - session date resolution", () => {
  const oneSession = (sessionDate: string | null) => ({
    event: aiEvent,
    sessions: [
      {
        sessionNumber: 1,
        titleEn: "Morning",
        sessionDate,
        timePeriod: "morning" as const,
        tracks: [{ importFileId: 10, title: "Track 1" }],
      },
    ],
  });
  const map = () => new Map<number, ProposedTrack>([[10, track(10, 1)]]);

  it("attaches a caller-supplied year to a year-less date", () => {
    const s = assembleProposedStructure(oneSession("October 6"), map(), proposedEvent(), [], {
      eventYear: "2019",
    });
    expect(s.sessions[0]?.sessionDate).toBe("2019-10-06");
  });

  it("falls back to the deterministic seed date when the AI supplies none", () => {
    const s = assembleProposedStructure(oneSession(null), map(), proposedEvent(), [], {
      eventYear: "2019",
      seedDateByFileId: new Map([[10, "October 6"]]),
    });
    expect(s.sessions[0]?.sessionDate).toBe("2019-10-06");
  });

  it("emits null rather than an unstorable non-ISO string when no year exists anywhere", () => {
    const undated = { ...proposedEvent(), startDate: null, endDate: null };
    const s = assembleProposedStructure(oneSession("October 6"), map(), undated, [], {
      eventYear: null,
    });
    expect(s.sessions[0]?.sessionDate).toBeNull();
  });

  it("falls back to the event's own start date year when the caller supplies none", () => {
    const s = assembleProposedStructure(oneSession("October 6"), map(), proposedEvent(), [], {});
    expect(s.sessions[0]?.sessionDate).toBe("2024-10-06");
  });

  it("passes an already-ISO date through untouched", () => {
    const s = assembleProposedStructure(oneSession("2024-04-25"), map(), proposedEvent(), [], {
      eventYear: "2019",
    });
    expect(s.sessions[0]?.sessionDate).toBe("2024-04-25");
  });
});
