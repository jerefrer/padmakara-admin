import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { eventVideos } from "../../db/schema/event-videos.ts";
import { AppError } from "../../lib/errors.ts";
import { hasTranscriptForLanguage } from "../../services/transcripts.ts";
import {
  submitSubtitleJob,
  cancelSubtitleJob,
  deleteSubtitleJob,
} from "../../services/subtitles.ts";

/**
 * Standalone routes for subtitle-job transcript checking, submission (with
 * an explicit no-transcript acknowledgement) and cancellation.
 *
 * Generation lives here rather than beside the other subtitle routes in
 * `videos.ts` because this is the only path that can carry
 * `acknowledgeNoTranscript`. The superseded
 * POST /admin/videos/:videoId/subtitles was removed rather than left in
 * place, since it could never pass the acknowledgement and would have
 * silently failed closed for any caller that found it. Listing, download
 * and translate remain video-scoped in `videos.ts`.
 */
const subtitleJobRoutes = new Hono();

/**
 * GET /admin/subtitle-jobs/transcript-status?videoId=&language=
 *
 * Whether the video's event has a transcript (with an uploaded file) in the
 * given language (defaults to "en", the only language subtitle generation
 * currently targets).
 */
subtitleJobRoutes.get("/transcript-status", async (c) => {
  const videoId = parseInt(c.req.query("videoId") ?? "", 10);
  const language = c.req.query("language") || "en";
  if (!Number.isFinite(videoId)) throw AppError.badRequest("videoId is required");

  const video = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
  });
  if (!video) throw AppError.notFound("Event video not found");

  const hasTranscript = await hasTranscriptForLanguage(video.eventId, language);
  return c.json({ hasTranscript, language });
});

/**
 * POST /admin/subtitle-jobs
 *
 * Submit a subtitle-generation job for an event_video. Body:
 * { videoId, language?, whisperModel?, acknowledgeNoTranscript? }
 */
subtitleJobRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const videoId = parseInt(String(body.videoId ?? ""), 10);
  if (!Number.isFinite(videoId)) throw AppError.badRequest("videoId is required");

  const result = await submitSubtitleJob(videoId, {
    language: typeof body.language === "string" ? body.language : undefined,
    whisperModel: typeof body.whisperModel === "string" ? body.whisperModel : undefined,
    acknowledgeNoTranscript: body.acknowledgeNoTranscript === true,
  });
  return c.json(result, 202);
});

/**
 * POST /admin/subtitle-jobs/:jobId/cancel
 *
 * Terminate a running/queued subtitle job.
 */
subtitleJobRoutes.post("/:jobId/cancel", async (c) => {
  const jobId = c.req.param("jobId");
  const result = await cancelSubtitleJob(jobId);
  return c.json(result);
});

/**
 * DELETE /admin/subtitle-jobs/:jobId
 *
 * Clear a finished job from the admin UI. Terminal jobs only.
 */
subtitleJobRoutes.delete("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const result = await deleteSubtitleJob(jobId);
  return c.json(result);
});

export { subtitleJobRoutes };
