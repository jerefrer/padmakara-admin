import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";
import { eq, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { events } from "../db/schema/retreats.ts";
import { tracks } from "../db/schema/tracks.ts";
import { subtitleJobs } from "../db/schema/subtitle-jobs.ts";
import { videoSubtitles } from "../db/schema/video-subtitles.ts";
import { config } from "../config.ts";
import { buildMp4DownloadUrl } from "./bunny.ts";
import { storageEnvForContainer } from "./s3.ts";
import { reconcileSubtitleRows, terminateBatchJob, TERMINAL_DB_STATUSES } from "./batch-reconcile.ts";
import { hasTranscriptForLanguage } from "./transcripts.ts";
import { AppError } from "../lib/errors.ts";

// Reason recorded on subtitle_jobs.error_message when an admin cancels a
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
  whisperModel?: string;
  // Explicit opt-in required to submit a Whisper job for an event/language
  // that has no transcript to guide it. Must be passed through verbatim
  // from the request body by the route — never inferred or defaulted true
  // — so the check below cannot be bypassed by omission.
  acknowledgeNoTranscript?: boolean;
}

/**
 * Submit a subtitle-generation job for an event_video.
 * Creates a DB job record and submits to AWS Batch.
 * Mirrors submitReadAlongJob in read-along.ts.
 */
export async function submitSubtitleJob(
  videoId: number,
  options: SubmitOptions = {},
) {
  const video = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
  });
  if (!video) throw new Error("Event video not found");

  const event = await db.query.events.findFirst({
    where: eq(events.id, video.eventId),
  });
  if (!event) throw new Error("Event not found");

  const language = options.language ?? "en";
  const whisperModel = options.whisperModel ?? "turbo";

  // Whisper is guided by the event's transcript for this language; without
  // one it falls back to raw transcription, which is materially worse on
  // names and Buddhist terminology. Refuse unless the caller has explicitly
  // acknowledged that tradeoff — this check is unconditional (not gated by
  // which route called us), so it cannot be bypassed by calling the API
  // directly with a different payload shape.
  if (!options.acknowledgeNoTranscript) {
    const hasTranscript = await hasTranscriptForLanguage(event.id, language);
    if (!hasTranscript) {
      throw AppError.badRequest(
        `No ${language} transcript found for event ${event.eventCode} — subtitle accuracy on names and Buddhist terminology will be materially worse without one. Pass acknowledgeNoTranscript to proceed anyway.`,
        "NO_TRANSCRIPT",
      );
    }
  }

  // TRACK_NUMBERS is the sorted, deduped union of trackNumber over ALL of
  // the event's tracks (joined via tracks → sessions where
  // session.eventId = event.id) — a video may span any slice of the event,
  // so the alignment pass considers every track in it.
  const eventSessions = await db.query.sessions.findMany({
    where: eq(sessions.eventId, event.id),
  });
  const sessionIds = eventSessions.map((s) => s.id);
  const eventTracks = sessionIds.length
    ? await db.query.tracks.findMany({
        where: inArray(tracks.sessionId, sessionIds),
      })
    : [];
  const trackNumbers = [...new Set(eventTracks.map((t) => t.trackNumber))].sort(
    (a, b) => a - b,
  );
  if (trackNumbers.length === 0) throw new Error("Event has no tracks to align against");

  // Create job record
  const [job] = await db
    .insert(subtitleJobs)
    .values({ videoId, language, whisperModel })
    .returning();

  // Lowest-resolution signed Bunny MP4 URL — only its audio track is needed
  // by the Whisper pipeline, so 240p minimises the download size.
  // Subtitles are transcribed from the Bunny-hosted audio, so a video whose
  // slide burn-in has not completed yet has nothing to transcribe from.
  if (!video.bunnyVideoId) {
    throw AppError.conflict("Video is still being processed — subtitles cannot be generated yet");
  }
  const { url: videoAudioUrl } = buildMp4DownloadUrl(video.bunnyVideoId, "240p");

  const eventCode = event.eventCode;
  const transcriptPrefix = `events/${eventCode}/transcripts/`;

  const webhookUrl = `${config.urls.backend}/api/webhooks/subtitles`;

  // The Batch container image is unchanged and requires SESSION_ID and
  // SESSION_NUMBER: SESSION_ID is echo-only (must stay int-parseable, so it
  // carries videoId), SESSION_NUMBER is only used to build a temp S3 key
  // (so it carries a "v<id>" label instead of a numeric session number).
  const command = new SubmitJobCommand({
    jobName: `subtitles-${eventCode}-v${videoId}`,
    jobDefinition: config.readAlong.jobDefinition,
    jobQueue: config.readAlong.jobQueue,
    containerOverrides: {
      environment: [
        ...storageEnvForContainer(),
        { name: "JOB_MODE", value: "subtitles" },
        { name: "JOB_ID", value: job!.id },
        { name: "SESSION_ID", value: String(videoId) },
        { name: "SESSION_VIDEO_ID", value: String(videoId) },
        { name: "EVENT_CODE", value: eventCode },
        { name: "SESSION_NUMBER", value: `v${videoId}` },
        { name: "TRACK_NUMBERS", value: trackNumbers.join(",") },
        { name: "LANGUAGE", value: language },
        { name: "WHISPER_MODEL", value: whisperModel },
        { name: "S3_BUCKET", value: config.storage.bucket },
        { name: "VIDEO_AUDIO_URL", value: videoAudioUrl },
        { name: "TRANSCRIPT_PREFIX", value: transcriptPrefix },
        { name: "WEBHOOK_URL", value: webhookUrl },
        { name: "WEBHOOK_SECRET", value: config.readAlong.webhookSecret },
      ],
    },
  });

  const response = await batchClient.send(command);

  await db
    .update(subtitleJobs)
    .set({
      batchJobId: response.jobId,
      status: "submitted",
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subtitleJobs.id, job!.id));

  return {
    jobId: job!.id,
    batchJobId: response.jobId,
    status: "submitted",
    videoId,
    language,
    trackCount: trackNumbers.length,
  };
}

/**
 * Get recent subtitle jobs for an event_video.
 *
 * Non-terminal rows are reconciled against AWS Batch's actual state first —
 * a Batch job that died without ever POSTing its completion webhook would
 * otherwise leave the row (and the admin UI) stuck "in progress" forever.
 */
export async function getSubtitleJobsForVideo(videoId: number) {
  const query = () =>
    db.query.subtitleJobs.findMany({
      where: eq(subtitleJobs.videoId, videoId),
      orderBy: [desc(subtitleJobs.createdAt)],
      limit: 10,
    });

  const rows = await query();
  await reconcileSubtitleRows(rows);
  return query();
}

/**
 * Get subtitle records (VTT files) for an event_video.
 */
export async function getVideoSubtitles(videoId: number) {
  return db.query.videoSubtitles.findMany({
    where: eq(videoSubtitles.videoId, videoId),
  });
}

/**
 * Cancel a running/queued subtitle job: asks AWS Batch to terminate it (best
 * effort — never throws even if the job already finished there) and marks
 * the DB row terminal with a reason distinguishable from a genuine failure.
 */
/**
 * Delete a finished subtitle job row so a failed attempt stops occupying the
 * admin UI. Only terminal jobs may be cleared — a running job must be
 * cancelled first, or deleting the row would orphan a live Batch job whose
 * webhook then has nothing to write back to.
 *
 * Deletes rather than flagging dismissed: a failed job produced no artifact,
 * so the row carries nothing worth keeping once an admin has read the error.
 */
export async function deleteSubtitleJob(jobId: string) {
  const job = await db.query.subtitleJobs.findFirst({
    where: eq(subtitleJobs.id, jobId),
  });
  if (!job) throw AppError.notFound("Subtitle job not found");
  if (!TERMINAL_DB_STATUSES.has(job.status)) {
    throw AppError.conflict("This job is still running — cancel it before clearing it");
  }

  await db.delete(subtitleJobs).where(eq(subtitleJobs.id, jobId));
  return { id: jobId, deleted: true };
}

export async function cancelSubtitleJob(jobId: string) {
  const job = await db.query.subtitleJobs.findFirst({
    where: eq(subtitleJobs.id, jobId),
  });
  if (!job) throw AppError.notFound("Subtitle job not found");
  if (TERMINAL_DB_STATUSES.has(job.status)) {
    throw AppError.conflict("This job has already finished and cannot be cancelled");
  }

  if (job.batchJobId) {
    await terminateBatchJob(job.batchJobId, CANCEL_REASON);
  }

  const completedAt = new Date();
  await db
    .update(subtitleJobs)
    .set({
      status: "failed",
      errorMessage: CANCEL_REASON,
      completedAt,
      updatedAt: new Date(),
    })
    .where(eq(subtitleJobs.id, jobId));

  return { ...job, status: "failed", errorMessage: CANCEL_REASON, completedAt };
}
