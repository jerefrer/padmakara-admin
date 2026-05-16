import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  importJobs,
  importFiles,
  events,
  sessions,
  tracks,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
  transcripts,
} from "../db/schema/index.ts";
import { AppError } from "../lib/errors.ts";
import {
  buildTrackS3Key,
  buildTranscriptS3Key,
  copyObjectIntoAppBucket,
} from "./s3.ts";
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

  // Resolve each confirmed transcript to its source file. A loose transcript
  // is copied to events/{code}/transcripts/{filename}; one inside a ZIP is
  // extracted with the audio ZIPs and ends up flat at events/{code}/{filename}.
  const resolvedTranscripts = structure.transcripts.map((t) => {
    const file = fileById.get(t.importFileId);
    if (!file) {
      throw AppError.badRequest(
        `Confirmed structure references transcript import file ${t.importFileId}, which does not belong to job ${importJobId}`,
      );
    }
    return { file, language: t.language };
  });

  // NOTE: a crash between this update and the try block below would leave the
  // job stuck in "importing" — the status guard then blocks re-execution until
  // an operator resets it to "reviewed". Accepted for this first cut.
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
    for (const rt of resolvedTranscripts) {
      if (rt.file.zipEntryName) zipKeys.add(rt.file.sourceS3Key);
    }
    // TODO: extractZip extracts the WHOLE source ZIP into events/{eventCode}/,
    // so entries not in the confirmed structure become orphan objects. Acceptable
    // for now; a future refinement could pass skipFiles or extract selectively.
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
    for (const rt of resolvedTranscripts) {
      if (!rt.file.zipEntryName) {
        await copyObjectIntoAppBucket(
          job.sourceBucket,
          rt.file.sourceS3Key,
          buildTranscriptS3Key(job.eventCode, rt.file.filename),
        );
      }
    }

    // --- DB phase (transactional) ---
    const retreatId = await db.transaction(async (tx) => {
      const ev = structure.event;
      const [retreat] = await tx
        .insert(events)
        .values({
          eventCode: job.eventCode,
          titleEn: ev.titleEn || job.eventCode,
          titlePt: ev.titlePt || null,
          mainThemesEn: ev.mainThemesEn || null,
          mainThemesPt: ev.mainThemesPt || null,
          sessionThemesEn: ev.sessionThemesEn || null,
          sessionThemesPt: ev.sessionThemesPt || null,
          startDate: ev.startDate,
          endDate: ev.endDate,
          eventTypeId: ev.eventTypeId,
          audienceId: ev.audienceId,
          status: ev.status || "draft",
          featuredAt: ev.featuredAt ? new Date(ev.featuredAt) : null,
        })
        .returning();
      if (!retreat) throw new Error("failed to create retreat row");

      // Junction rows for the event's teachers / retreat groups / places.
      if (ev.teacherIds.length > 0) {
        await tx.insert(eventTeachers).values(
          ev.teacherIds.map((teacherId) => ({
            eventId: retreat.id,
            teacherId,
            role: "teacher",
          })),
        );
      }
      if (ev.groupIds.length > 0) {
        await tx.insert(eventRetreatGroups).values(
          ev.groupIds.map((retreatGroupId) => ({
            eventId: retreat.id,
            retreatGroupId,
          })),
        );
      }
      if (ev.placeIds.length > 0) {
        await tx.insert(eventPlaces).values(
          ev.placeIds.map((placeId) => ({ eventId: retreat.id, placeId })),
        );
      }

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

      // Transcript rows — one per confirmed PDF. The S3 key is the real
      // location: a loose transcript was copied under .../transcripts/, one
      // from a ZIP was extracted flat to events/{code}/.
      for (const rt of resolvedTranscripts) {
        const s3Key = rt.file.zipEntryName
          ? `events/${job.eventCode}/${rt.file.filename}`
          : buildTranscriptS3Key(job.eventCode, rt.file.filename);
        await tx.insert(transcripts).values({
          eventId: retreat.id,
          language: rt.language,
          s3Key,
          status: ev.status || "draft",
          originalFilename: rt.file.filename,
          fileSizeBytes: rt.file.sizeBytes,
        });
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
