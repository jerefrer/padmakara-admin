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
        { name: "JOB_MODE", value: "subtitles" },
        { name: "JOB_ID", value: job!.id },
        { name: "SESSION_ID", value: String(videoId) },
        { name: "SESSION_VIDEO_ID", value: String(videoId) },
        { name: "EVENT_CODE", value: eventCode },
        { name: "SESSION_NUMBER", value: `v${videoId}` },
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
    videoId,
    language,
    trackCount: trackNumbers.length,
  };
}

/**
 * Get recent subtitle jobs for an event_video.
 */
export async function getSubtitleJobsForVideo(videoId: number) {
  return db.query.subtitleJobs.findMany({
    where: eq(subtitleJobs.videoId, videoId),
    orderBy: [desc(subtitleJobs.createdAt)],
    limit: 10,
  });
}

/**
 * Get subtitle records (VTT files) for an event_video.
 */
export async function getVideoSubtitles(videoId: number) {
  return db.query.videoSubtitles.findMany({
    where: eq(videoSubtitles.videoId, videoId),
  });
}
