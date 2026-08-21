import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { readAlongJobs } from "../db/schema/read-along-jobs.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { putObject, storageEnvForContainer } from "./s3.ts";
import { reconcileReadAlongRows, terminateBatchJob, TERMINAL_DB_STATUSES } from "./batch-reconcile.ts";

// Reason recorded on read_along_jobs.error_message when an admin cancels a
// job. friendlyJobError() (admin/src/utils/friendlyJobError.ts) special-cases
// this text so the UI shows "cancelled", not "crashed".
const CANCEL_REASON = "Cancelled by an administrator";

const batchClient = new BatchClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

interface SubmitOptions {
  language?: string;
  skipPages?: number;
  whisperModel?: string;
}

/**
 * Submit a read-along alignment job for an event.
 * Creates a DB job record and submits to AWS Batch.
 */
export async function submitReadAlongJob(
  eventId: number,
  options: SubmitOptions = {},
) {
  // Verify event exists and has what we need
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
  });
  if (!event) throw AppError.notFound("Event not found");

  // Check for transcript to determine language
  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.eventId, eventId),
  });

  const language = options.language ?? transcript?.language ?? "en";
  const skipPages = options.skipPages ?? 7;
  const whisperModel = options.whisperModel ?? "turbo";

  // Build the audio S3 key list. Only original-language tracks are aligned —
  // translation tracks (e.g. Portuguese voice-over of an English teaching) are
  // skipped because the PDF is in the original language and aligning a
  // different-language audio against it produces useless output. Filtering
  // here also halves cost/wall-time vs. the container's prefix-listing fallback.
  const audioTracks = await db
    .select({ s3Key: tracks.s3Key })
    .from(tracks)
    .innerJoin(sessions, eq(sessions.id, tracks.sessionId))
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(tracks.originalLanguage, language),
        eq(tracks.isTranslation, false),
        isNotNull(tracks.s3Key),
      ),
    );

  const audioS3Keys = audioTracks
    .map((t) => t.s3Key)
    .filter((k): k is string => Boolean(k));

  if (audioS3Keys.length === 0) {
    throw AppError.badRequest(
      `No ${language} original-language tracks found for event ${event.eventCode}`,
      "NO_ELIGIBLE_TRACKS",
    );
  }

  // Create job record
  const [job] = await db
    .insert(readAlongJobs)
    .values({
      eventId,
      language,
      skipPages,
      whisperModel,
      status: "pending",
    })
    .returning();

  // Upload the track list to S3 instead of passing it inline. AWS Batch caps
  // the total size of containerOverrides at 8192 bytes, which an 80+ track
  // event blows through immediately.
  const audioKeysS3Key = `read-along-jobs/${job!.id}/audio_keys.json`;
  await putObject(
    audioKeysS3Key,
    Buffer.from(JSON.stringify(audioS3Keys)),
    "application/json",
  );

  // Build webhook URL
  const webhookUrl = `${config.urls.backend}/api/webhooks/read-along`;

  // Submit to AWS Batch
  const command = new SubmitJobCommand({
    jobName: `read-along-${event.eventCode}`,
    jobDefinition: config.readAlong.jobDefinition,
    jobQueue: config.readAlong.jobQueue,
    containerOverrides: {
      environment: [
        ...storageEnvForContainer(),
        { name: "EVENT_CODE", value: event.eventCode },
        { name: "EVENT_ID", value: String(eventId) },
        { name: "JOB_ID", value: job!.id },
        { name: "S3_BUCKET", value: config.storage.bucket },
        { name: "LANGUAGE", value: language },
        { name: "SKIP_PAGES", value: String(skipPages) },
        { name: "WHISPER_MODEL", value: whisperModel },
        { name: "AUDIO_KEYS_S3_KEY", value: audioKeysS3Key },
        { name: "WEBHOOK_URL", value: webhookUrl },
        { name: "WEBHOOK_SECRET", value: config.readAlong.webhookSecret },
      ],
    },
  });

  const response = await batchClient.send(command);

  // Update job with Batch job ID
  await db
    .update(readAlongJobs)
    .set({
      batchJobId: response.jobId,
      status: "submitted",
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(readAlongJobs.id, job!.id));

  return {
    jobId: job!.id,
    batchJobId: response.jobId,
    status: "submitted",
    eventCode: event.eventCode,
    language,
    skipPages,
    whisperModel,
    trackCount: audioS3Keys.length,
  };
}

/**
 * Get recent read-along jobs for an event.
 *
 * Non-terminal rows are reconciled against AWS Batch's actual state first —
 * a Batch job that died without ever POSTing its completion webhook would
 * otherwise leave the row (and the admin UI) stuck "in progress" forever.
 */
export async function getReadAlongJobs(eventId: number) {
  const query = () =>
    db.query.readAlongJobs.findMany({
      where: eq(readAlongJobs.eventId, eventId),
      orderBy: [desc(readAlongJobs.createdAt)],
      limit: 10,
    });

  const rows = await query();
  await reconcileReadAlongRows(rows);
  return query();
}

/**
 * Cancel a running/queued read-along job: asks AWS Batch to terminate it
 * (best effort — never throws even if the job already finished there) and
 * marks the DB row terminal with a reason distinguishable from a genuine
 * failure.
 */
export async function cancelReadAlongJob(jobId: string) {
  const job = await db.query.readAlongJobs.findFirst({
    where: eq(readAlongJobs.id, jobId),
  });
  if (!job) throw AppError.notFound("Read-along job not found");
  if (TERMINAL_DB_STATUSES.has(job.status)) {
    throw AppError.conflict("This job has already finished and cannot be cancelled");
  }

  if (job.batchJobId) {
    await terminateBatchJob(job.batchJobId, CANCEL_REASON);
  }

  const completedAt = new Date();
  await db
    .update(readAlongJobs)
    .set({
      status: "failed",
      errorMessage: CANCEL_REASON,
      completedAt,
      updatedAt: new Date(),
    })
    .where(eq(readAlongJobs.id, jobId));

  return { ...job, status: "failed", errorMessage: CANCEL_REASON, completedAt };
}
