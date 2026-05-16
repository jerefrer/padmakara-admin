import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import {
  importJobs,
  importFiles,
  events,
  sessions,
  tracks,
} from "../../src/db/schema/index.ts";

const mockCopy = vi.hoisted(() => vi.fn(async () => {}));
const mockExtract = vi.hoisted(() =>
  vi.fn(async () => ({ extractedFiles: 0, skippedFiles: 0 })),
);

vi.mock("../../src/services/s3.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/s3.ts")>();
  return { ...actual, copyObjectIntoAppBucket: mockCopy };
});
vi.mock("../../src/services/zip-extractor.ts", () => ({
  extractZip: mockExtract,
}));

import { executeImport } from "../../src/services/import-executor.ts";

const EVENT_CODE = "EV-EXECUTE";

async function cleanup() {
  await db.delete(events).where(eq(events.eventCode, EVENT_CODE));
  await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
}

/**
 * Seed a reviewed job with two loose files + one ZIP-entry file, and a
 * confirmed structure of two sessions. Returns the job id.
 */
async function seedReviewedJob(): Promise<number> {
  const [job] = await db
    .insert(importJobs)
    .values({ eventCode: EVENT_CODE, status: "reviewed" })
    .returning();
  const files = await db
    .insert(importFiles)
    .values([
      { importJobId: job!.id, sourceS3Key: "mediateca/EV/a.mp3", filename: "001 JKR - A.mp3", extension: ".mp3", category: "audio1", sizeBytes: 100 },
      { importJobId: job!.id, sourceS3Key: "mediateca/EV/b.mp3", filename: "002 JKR - B.mp3", extension: ".mp3", category: "audio1", sizeBytes: 200 },
      { importJobId: job!.id, sourceS3Key: "mediateca/EV/Audio 1/c.zip", zipEntryName: "x/003 JKR - C.mp3", filename: "003 JKR - C.mp3", extension: ".mp3", category: "audio1", sizeBytes: 300 },
    ])
    .returning();
  const structure = {
    sessions: [
      {
        sessionNumber: 1,
        titleEn: "Morning",
        sessionDate: "2024-04-25",
        timePeriod: "morning",
        tracks: [
          { importFileId: files[0]!.id, trackNumber: 1, title: "A", speaker: "JKR", languages: ["en"], originalLanguage: "en", isTranslation: false, originalFilename: "001 JKR - A.mp3" },
          { importFileId: files[1]!.id, trackNumber: 2, title: "B", speaker: "JKR", languages: ["en"], originalLanguage: "en", isTranslation: false, originalFilename: "002 JKR - B.mp3" },
        ],
      },
      {
        sessionNumber: 2,
        titleEn: "Afternoon",
        sessionDate: "2024-04-25",
        timePeriod: "afternoon",
        tracks: [
          { importFileId: files[2]!.id, trackNumber: 3, title: "C", speaker: "JKR", languages: ["en"], originalLanguage: "en", isTranslation: false, originalFilename: "003 JKR - C.mp3" },
        ],
      },
    ],
  };
  await db
    .update(importJobs)
    .set({ confirmedStructure: structure })
    .where(eq(importJobs.id, job!.id));
  return job!.id;
}

describe("executeImport", () => {
  beforeEach(async () => {
    await cleanup();
    mockCopy.mockClear();
    mockExtract.mockClear();
  });

  it("throws for an unknown job", async () => {
    await expect(executeImport(99999999)).rejects.toThrow(/not found/i);
  });

  it("throws when the job is not reviewed", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "cataloged" })
      .returning();
    await expect(executeImport(job!.id)).rejects.toThrow(/reviewed/i);
  });

  it("copies/extracts files and creates retreat, sessions and tracks", async () => {
    const jobId = await seedReviewedJob();
    const job = await executeImport(jobId);

    expect(job.status).toBe("completed");
    expect(job.retreatId).not.toBeNull();

    // 2 loose files copied, 1 distinct ZIP extracted
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(mockExtract).toHaveBeenCalledTimes(1);

    const [retreat] = await db
      .select()
      .from(events)
      .where(eq(events.eventCode, EVENT_CODE));
    expect(retreat).toBeDefined();

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, retreat!.id))
      .orderBy(sessions.sessionNumber);
    expect(sessionRows).toHaveLength(2);
    expect(sessionRows[0]?.sessionNumber).toBe(1);

    const s1Tracks = await db
      .select()
      .from(tracks)
      .where(eq(tracks.sessionId, sessionRows[0]!.id));
    const s2Tracks = await db
      .select()
      .from(tracks)
      .where(eq(tracks.sessionId, sessionRows[1]!.id));
    expect(s1Tracks).toHaveLength(2);
    expect(s2Tracks).toHaveLength(1);
    expect(s1Tracks[0]?.s3Key).toContain(`events/${EVENT_CODE}/`);
  });

  it("marks the job failed and rethrows when a copy fails", async () => {
    const jobId = await seedReviewedJob();
    mockCopy.mockRejectedValueOnce(new Error("S3 copy boom"));
    await expect(executeImport(jobId)).rejects.toThrow(/boom/);

    const [job] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId));
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("boom");
  });

  it("refuses to import an event code that already exists", async () => {
    const jobId = await seedReviewedJob();
    await db
      .insert(events)
      .values({ eventCode: EVENT_CODE, titleEn: "Existing" });
    await expect(executeImport(jobId)).rejects.toThrow(/already exists/i);

    // pre-validation failure must leave the job reviewable, not failed
    const [job] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId));
    expect(job?.status).toBe("reviewed");
  });
});
