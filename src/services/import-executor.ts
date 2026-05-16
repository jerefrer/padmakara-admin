import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  importJobs,
  importFiles,
  events,
  sessions,
  tracks,
} from "../db/schema/index.ts";
import { AppError } from "../lib/errors.ts";
import { buildTrackS3Key, copyObjectIntoAppBucket } from "./s3.ts";
import { extractZip } from "./zip-extractor.ts";
import { proposedStructureSchema } from "./import-inference.ts";

/**
 * Execute a reviewed import job: copy/extract its audio from the legacy
 * source bucket into the app bucket (server-side, zero egress), then create
 * the real retreats/sessions/tracks rows. On any failure the job is marked
 * `failed` (with the error message) and the error is rethrown.
 *
 * ZIP entries are produced by invoking the extractor Lambda once per distinct
 * source ZIP (it extracts the whole ZIP into events/{eventCode}/); loose
 * files are copied individually. Every track's final key is
 * events/{eventCode}/{filename}.
 */
export async function executeImport(importJobId: number) {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId));
  if (!job) {
    throw AppError.notFound(`Import job ${importJobId} not found`);
  }
  if (job.status !== "reviewed") {
    throw AppError.badRequest(
      `Import job ${importJobId} is in status "${job.status}"; only a reviewed job can be executed`,
      "INVALID_JOB_STATUS",
    );
  }

  const structure = proposedStructureSchema.parse(job.confirmedStructure);

  const [existingEvent] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.eventCode, job.eventCode));
  if (existingEvent) {
    throw AppError.conflict(
      `An event with code ${job.eventCode} already exists (id ${existingEvent.id})`,
    );
  }

  const sourceFiles = await db
    .select()
    .from(importFiles)
    .where(eq(importFiles.importJobId, importJobId));
  const fileById = new Map(sourceFiles.map((f) => [f.id, f]));

  // Resolve every structure track to its source file + final key, and
  // detect destination-key collisions BEFORE touching S3.
  const resolved = structure.sessions.flatMap((session) =>
    session.tracks.map((track) => {
      const file = fileById.get(track.importFileId);
      if (!file) {
        throw AppError.badRequest(
          `Confirmed structure references import file ${track.importFileId}, which does not belong to job ${importJobId}`,
        );
      }
      return {
        file,
        targetKey: buildTrackS3Key(
          job.eventCode,
          session.sessionNumber,
          file.filename,
        ),
      };
    }),
  );
  const seenKeys = new Set<string>();
  for (const r of resolved) {
    if (seenKeys.has(r.targetKey)) {
      throw AppError.badRequest(
        `Two tracks resolve to the same destination key "${r.targetKey}" — rename one before importing`,
      );
    }
    seenKeys.add(r.targetKey);
  }

  await db
    .update(importJobs)
    .set({ status: "importing", errorMessage: null, updatedAt: new Date() })
    .where(eq(importJobs.id, importJobId));

  try {
    // --- copy/extract phase (server-side, no egress) ---
    const eventPrefix = `events/${job.eventCode}`;
    const zipKeys = new Set<string>();
    for (const r of resolved) {
      if (r.file.zipEntryName) zipKeys.add(r.file.sourceS3Key);
    }
    for (const zipKey of zipKeys) {
      await extractZip({
        sourceBucket: job.sourceBucket,
        zipKey,
        targetPrefix: eventPrefix,
      });
    }
    for (const r of resolved) {
      if (!r.file.zipEntryName) {
        await copyObjectIntoAppBucket(
          job.sourceBucket,
          r.file.sourceS3Key,
          r.targetKey,
        );
      }
    }

    // --- DB phase (transactional) ---
    const retreatId = await db.transaction(async (tx) => {
      const [retreat] = await tx
        .insert(events)
        .values({
          eventCode: job.eventCode,
          titleEn: job.eventCode,
          status: "draft",
        })
        .returning();
      if (!retreat) throw new Error("failed to create retreat row");

      for (const session of structure.sessions) {
        const [sessionRow] = await tx
          .insert(sessions)
          .values({
            eventId: retreat.id,
            sessionNumber: session.sessionNumber,
            titleEn: session.titleEn,
            sessionDate: session.sessionDate,
            timePeriod: session.timePeriod,
          })
          .returning();
        if (!sessionRow) throw new Error("failed to create session row");

        for (const track of session.tracks) {
          const file = fileById.get(track.importFileId);
          if (!file) throw new Error(`import file ${track.importFileId} missing`);
          await tx.insert(tracks).values({
            sessionId: sessionRow.id,
            trackNumber: track.trackNumber,
            title: track.title,
            speaker: track.speaker,
            languages: track.languages,
            originalLanguage: track.originalLanguage,
            isTranslation: track.isTranslation,
            s3Key: buildTrackS3Key(
              job.eventCode,
              session.sessionNumber,
              file.filename,
            ),
            fileSizeBytes: file.sizeBytes,
            originalFilename: file.filename,
          });
        }
      }
      return retreat.id;
    });

    const [completed] = await db
      .update(importJobs)
      .set({
        status: "completed",
        retreatId,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, importJobId))
      .returning();
    if (!completed) throw new Error("import job vanished during execution");
    return completed;
  } catch (err) {
    await db
      .update(importJobs)
      .set({
        status: "failed",
        errorMessage: (err as Error).message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, importJobId));
    throw err;
  }
}
