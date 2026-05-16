import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs, importFiles } from "../../src/db/schema/index.ts";

// Mutable holder so the test can set the mocked Claude response AFTER it knows
// the inserted import_file ids. `mock`-prefixed so the hoisted vi.mock factory
// is allowed to reference it.
const mockClaude = { text: "" };

vi.mock("@anthropic-ai/sdk", () => {
  function MockAnthropic() {
    return {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: "text", text: mockClaude.text }],
        })),
      },
    };
  }
  return { default: MockAnthropic };
});

import {
  refineStructure,
  type ProposedStructure,
  type ProposedEvent,
} from "../../src/services/import-inference.ts";

const EVENT_CODE = "EV-REFINE";

/** A minimal event block — refinement passes it through untouched. */
const STUB_EVENT: ProposedEvent = {
  titleEn: "Refine Retreat",
  titlePt: "",
  mainThemesEn: "",
  mainThemesPt: "",
  sessionThemesEn: "",
  sessionThemesPt: "",
  startDate: null,
  endDate: null,
  status: "draft",
  featuredAt: null,
  eventTypeId: null,
  audienceId: null,
  teacherIds: [],
  placeIds: [],
  groupIds: [],
};

async function seedProposedJob(): Promise<{
  jobId: number;
  fileIds: number[];
  filenames: string[];
  currentStructure: ProposedStructure;
}> {
  const [job] = await db
    .insert(importJobs)
    .values({ eventCode: EVENT_CODE, status: "proposed" })
    .returning();
  const filenames = [
    "001 JKR - Opening.mp3",
    "002 JKR - Morning teaching.mp3",
    "003 JKR - Afternoon teaching.mp3",
  ];
  const inserted = await db
    .insert(importFiles)
    .values(
      filenames.map((filename, i) => ({
        importJobId: job!.id,
        sourceS3Key: `s/${i + 1}.mp3`,
        filename,
        extension: ".mp3",
        category: "audio1",
      })),
    )
    .returning();
  const fileIds = inserted.map((f) => f.id);

  // A plausible current structure the human might send
  const currentStructure: ProposedStructure = {
    event: STUB_EVENT,
    sessions: [
      {
        sessionNumber: 1,
        titleEn: "Session 1",
        sessionDate: null,
        timePeriod: "morning",
        tracks: [
          {
            importFileId: fileIds[0]!,
            trackNumber: 1,
            title: "Opening",
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: filenames[0]!,
          },
          {
            importFileId: fileIds[1]!,
            trackNumber: 2,
            title: "Morning teaching",
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: filenames[1]!,
          },
        ],
      },
      {
        sessionNumber: 2,
        titleEn: "Session 2",
        sessionDate: null,
        timePeriod: "afternoon",
        tracks: [
          {
            importFileId: fileIds[2]!,
            trackNumber: 1,
            title: "Afternoon teaching",
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: filenames[2]!,
          },
        ],
      },
    ],
    ignored: [],
    transcripts: [],
  };

  return { jobId: job!.id, fileIds, filenames, currentStructure };
}

describe("refineStructure", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
    mockClaude.text = "";
  });

  it("throws not found for an unknown import job", async () => {
    const stub: ProposedStructure = {
      event: STUB_EVENT,
      sessions: [],
      ignored: [],
      transcripts: [],
    };
    await expect(refineStructure(999999, stub, "merge")).rejects.toThrow(
      /not found/i,
    );
  });

  it("throws when the job status does not allow refinement", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "cataloged" })
      .returning();
    const stub: ProposedStructure = {
      event: STUB_EVENT,
      sessions: [],
      ignored: [],
      transcripts: [],
    };
    await expect(refineStructure(job!.id, stub, "merge")).rejects.toThrow(
      /cannot be refined/i,
    );
  });

  it("happy path: merges sessions, re-anchors originalFilename, sets status to proposed", async () => {
    const { jobId, fileIds, filenames, currentStructure } =
      await seedProposedJob();

    // AI returns everything merged into one session — NOTE: no originalFilename
    // in the AI output (the refineOutputSchema intentionally omits it).
    // The AI deliberately returns a wrong filename-like field to prove it is
    // ignored; originalFilename must come from import_files.
    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Merged Session",
          sessionDate: "2024-04-25",
          timePeriod: "morning",
          tracks: fileIds.map((id, i) => ({
            importFileId: id,
            trackNumber: i + 1,
            title: `Track ${i + 1}`,
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            // intentionally absent originalFilename — the schema strips it
          })),
        },
      ],
    });

    const updatedJob = await refineStructure(
      jobId,
      currentStructure,
      "merge everything into one session",
    );

    expect(updatedJob.status).toBe("proposed");
    const structure = updatedJob.proposedStructure as ProposedStructure;
    expect(structure.sessions).toHaveLength(1);
    expect(structure.sessions[0]?.tracks).toHaveLength(3);
    expect(structure.sessions[0]?.titleEn).toBe("Merged Session");

    // originalFilename must be re-anchored from import_files, not taken from AI
    for (const [idx, track] of structure.sessions[0]!.tracks.entries()) {
      expect(track.originalFilename).toBe(filenames[idx]);
    }
  });

  it("throws when the AI drops an import file from the output", async () => {
    const { jobId, fileIds, currentStructure } = await seedProposedJob();

    // AI output omits the last file
    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Partial",
          sessionDate: null,
          timePeriod: "morning",
          tracks: fileIds.slice(0, 2).map((id, i) => ({
            importFileId: id,
            trackNumber: i + 1,
            title: `Track ${i + 1}`,
            speaker: null,
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
          })),
        },
      ],
    });

    await expect(
      refineStructure(jobId, currentStructure, "drop the last track"),
    ).rejects.toThrow(/dropped/i);
  });

  it("preserves an ignored track across a refinement and re-anchors it", async () => {
    const { jobId, fileIds, filenames } = await seedProposedJob();

    // The human has set the third file aside in `ignored`.
    const withIgnored: ProposedStructure = {
      event: STUB_EVENT,
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Session 1",
          sessionDate: null,
          timePeriod: "morning",
          tracks: [0, 1].map((i) => ({
            importFileId: fileIds[i]!,
            trackNumber: i + 1,
            title: `Track ${i + 1}`,
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: filenames[i]!,
          })),
        },
      ],
      ignored: [
        {
          importFileId: fileIds[2]!,
          trackNumber: 1,
          title: "Afternoon teaching",
          speaker: "JKR",
          languages: ["en"],
          originalLanguage: "en",
          isTranslation: false,
          originalFilename: filenames[2]!,
        },
      ],
      transcripts: [],
    };

    // AI keeps the same split — sessions plus a one-track ignored list.
    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Session 1",
          sessionDate: null,
          timePeriod: "morning",
          tracks: [fileIds[0]!, fileIds[1]!].map((id, i) => ({
            importFileId: id,
            trackNumber: i + 1,
            title: `Track ${i + 1}`,
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
          })),
        },
      ],
      ignored: [
        {
          importFileId: fileIds[2]!,
          trackNumber: 1,
          title: "Afternoon teaching",
          speaker: "JKR",
          languages: ["en"],
          originalLanguage: "en",
          isTranslation: false,
        },
      ],
    });

    const updatedJob = await refineStructure(
      jobId,
      withIgnored,
      "leave the ignored file as it is",
    );

    const structure = updatedJob.proposedStructure as ProposedStructure;
    expect(structure.sessions).toHaveLength(1);
    expect(structure.sessions[0]?.tracks).toHaveLength(2);
    expect(structure.ignored).toHaveLength(1);
    expect(structure.ignored[0]?.importFileId).toBe(fileIds[2]);
    // originalFilename is re-anchored from import_files, not the AI output.
    expect(structure.ignored[0]?.originalFilename).toBe(filenames[2]);
  });

  it("passes the event block through a refinement unchanged", async () => {
    const { jobId, fileIds, currentStructure } = await seedProposedJob();
    const customEvent: ProposedEvent = {
      ...STUB_EVENT,
      titleEn: "My Retreat",
      startDate: "2024-04-25",
      teacherIds: [7],
    };

    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Merged",
          sessionDate: null,
          timePeriod: "morning",
          tracks: fileIds.map((id, i) => ({
            importFileId: id,
            trackNumber: i + 1,
            title: `Track ${i + 1}`,
            speaker: null,
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
          })),
        },
      ],
    });

    const updated = await refineStructure(
      jobId,
      { ...currentStructure, event: customEvent },
      "merge everything",
    );

    const structure = updated.proposedStructure as ProposedStructure;
    expect(structure.event).toEqual(customEvent);
  });
});
