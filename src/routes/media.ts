import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware } from "../middleware/auth.ts";

const mediaRoutes = new Hono();

mediaRoutes.use("*", authMiddleware);

/**
 * GET /api/media/audio/:trackId - Get presigned S3 URL for audio playback
 */
mediaRoutes.get("/audio/:trackId", async (c) => {
  const trackId = parseInt(c.req.param("trackId"), 10);

  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, trackId),
  });

  if (!track) throw AppError.notFound("Track not found");
  if (!track.s3Key) throw AppError.notFound("Audio file not available");

  const url = await generatePresignedDownloadUrl(track.s3Key);
  return c.json({ url, expiresIn: 3600 });
});

/**
 * GET /api/media/transcript/:transcriptId - Get presigned S3 URL for PDF
 */
mediaRoutes.get("/transcript/:transcriptId", async (c) => {
  const transcriptId = parseInt(c.req.param("transcriptId"), 10);

  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.id, transcriptId),
  });

  if (!transcript) throw AppError.notFound("Transcript not found");
  if (!transcript.s3Key) throw AppError.notFound("Transcript file not available");

  const url = await generatePresignedDownloadUrl(transcript.s3Key);
  return c.json({ url, expiresIn: 3600 });
});

export { mediaRoutes };
