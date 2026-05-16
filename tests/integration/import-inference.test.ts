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
  proposeStructure,
  type ProposedStructure,
} from "../../src/services/import-inference.ts";

const EVENT_CODE = "TEST-PROPOSE";

async function seedJob(): Promise<{ jobId: number; fileIds: number[] }> {
  const [job] = await db
    .insert(importJobs)
    .values({ eventCode: EVENT_CODE, status: "cataloged" })
    .returning();
  const inserted = await db
    .insert(importFiles)
    .values([
      { importJobId: job!.id, sourceS3Key: "s/a.mp3", filename: "001 JKR - Opening prayers.mp3", extension: ".mp3", category: "audio1" },
      { importJobId: job!.id, sourceS3Key: "s/b.mp3", filename: "002 JKR - Morning teaching.mp3", extension: ".mp3", category: "audio1" },
      { importJobId: job!.id, sourceS3Key: "s/c.mp3", filename: "003 JKR - Afternoon teaching.mp3", extension: ".mp3", category: "audio1" },
    ])
    .returning();
  return { jobId: job!.id, fileIds: inserted.map((f) => f.id) };
}

describe("proposeStructure", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
    mockClaude.text = "";
  });

  it("throws when the import job does not exist", async () => {
    await expect(proposeStructure(999999)).rejects.toThrow(/not found/i);
  });

  it("throws when the job has no audio files", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "cataloged" })
      .returning();
    await db.insert(importFiles).values({
      importJobId: job!.id,
      sourceS3Key: "s/t.pdf",
      filename: "transcript.pdf",
      extension: ".pdf",
      category: "transcript",
    });
    await expect(proposeStructure(job!.id)).rejects.toThrow(/no audio/i);
  });

  it("stores the AI-proposed structure and marks the job proposed", async () => {
    const { jobId, fileIds } = await seedJob();
    mockClaude.text = JSON.stringify({
      sessions: [
        { sessionNumber: 1, titleEn: "Morning", sessionDate: null, timePeriod: "morning", importFileIds: fileIds.slice(0, 2) },
        { sessionNumber: 2, titleEn: "Afternoon", sessionDate: null, timePeriod: "afternoon", importFileIds: fileIds.slice(2) },
      ],
    });

    const job = await proposeStructure(jobId);

    expect(job.status).toBe("proposed");
    // proposed_structure is an untyped jsonb column
    const structure = job.proposedStructure as ProposedStructure;
    expect(structure.sessions).toHaveLength(2);
    expect(structure.sessions[0]?.tracks).toHaveLength(2);
    expect(structure.sessions[1]?.tracks).toHaveLength(1);
    expect(structure.sessions[0]?.tracks[0]?.importFileId).toBe(fileIds[0]);
  });

  it("rejects an AI grouping that omits a file", async () => {
    const { jobId, fileIds } = await seedJob();
    mockClaude.text = JSON.stringify({
      sessions: [
        { sessionNumber: 1, titleEn: "Morning", sessionDate: null, timePeriod: "morning", importFileIds: fileIds.slice(0, 2) },
      ],
    });
    await expect(proposeStructure(jobId)).rejects.toThrow();
  });
});
