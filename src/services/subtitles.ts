import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";
import { sessionVideos } from "../db/schema/session-videos.ts";
import { events } from "../db/schema/retreats.ts";
import { tracks } from "../db/schema/tracks.ts";
import { subtitleJobs } from "../db/schema/subtitle-jobs.ts";
import { sessionSubtitles } from "../db/schema/session-subtitles.ts";
import { config } from "../config.ts";
import { buildMp4DownloadUrl } from "./bunny.ts";

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
}

/**
 * Submit a subtitle-generation job for a session_video.
 * Creates a DB job record and submits to AWS Batch.
 * Mirrors submitReadAlongJob in read-along.ts.
 */
export async function submitSubtitleJob(
  sessionVideoId: number,
  options: SubmitOptions = {},
) {
  const video = await db.query.sessionVideos.findFirst({
    where: eq(sessionVideos.id, sessionVideoId),
  });
  if (!video) throw new Error("Session video not found");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, video.sessionId),
  });
  if (!session) throw new Error("Session not found");

  const event = await db.query.events.findFirst({
    where: eq(events.id, session.eventId),
  });
  if (!event) throw new Error("Event not found");

  const language = options.language ?? "en";
  const whisperModel = options.whisperModel ?? "turbo";

  const sessionTracks = await db.query.tracks.findMany({
    where: eq(tracks.sessionId, session.id),
  });
  const trackNumbers = sessionTracks
    .map((t) => t.trackNumber)
    .sort((a, b) => a - b);
  if (trackNumbers.length === 0) throw new Error("Session has no tracks to align against");

  // Create job record
  const [job] = await db
    .insert(subtitleJobs)
    .values({ sessionId: session.id, sessionVideoId, language, whisperModel })
    .returning();

  // Lowest-resolution signed Bunny MP4 URL — only its audio track is needed
  // by the Whisper pipeline, so 240p minimises the download size.
  const { url: videoAudioUrl } = buildMp4DownloadUrl(video.bunnyVideoId, "240p");

  const eventCode = event.eventCode;
  const transcriptPrefix = `events/${eventCode}/transcripts/`;

  const webhookUrl = `${config.urls.backend}/api/webhooks/subtitles`;

  const command = new SubmitJobCommand({
    jobName: `subtitles-${eventCode}-s${session.sessionNumber}-v${sessionVideoId}`,
    jobDefinition: config.readAlong.jobDefinition,
    jobQueue: config.readAlong.jobQueue,
    containerOverrides: {
      environment: [
        { name: "JOB_MODE", value: "subtitles" },
        { name: "JOB_ID", value: job!.id },
        { name: "SESSION_ID", value: String(session.id) },
        { name: "SESSION_VIDEO_ID", value: String(sessionVideoId) },
        { name: "EVENT_CODE", value: eventCode },
        { name: "SESSION_NUMBER", value: String(session.sessionNumber) },
        { name: "TRACK_NUMBERS", value: trackNumbers.join(",") },
        { name: "LANGUAGE", value: language },
        { name: "WHISPER_MODEL", value: whisperModel },
        { name: "S3_BUCKET", value: config.aws.s3Bucket },
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
    sessionId: session.id,
    sessionVideoId,
    language,
    trackCount: trackNumbers.length,
  };
}

/**
 * Get recent subtitle jobs for a session_video.
 */
export async function getSubtitleJobsForVideo(sessionVideoId: number) {
  return db.query.subtitleJobs.findMany({
    where: eq(subtitleJobs.sessionVideoId, sessionVideoId),
    orderBy: [desc(subtitleJobs.createdAt)],
    limit: 10,
  });
}

/**
 * Get subtitle records (VTT files) for a session_video.
 */
export async function getVideoSubtitles(sessionVideoId: number) {
  return db.query.sessionSubtitles.findMany({
    where: eq(sessionSubtitles.sessionVideoId, sessionVideoId),
  });
}

/**
 * Get subtitle records (VTT files) for all of a session's videos —
 * denormalized session-level listing.
 */
export async function getSessionSubtitles(sessionId: number) {
  return db.query.sessionSubtitles.findMany({
    where: eq(sessionSubtitles.sessionId, sessionId),
  });
}
