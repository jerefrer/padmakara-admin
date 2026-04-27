import { Hono } from "hono";
import { generatePresignedUploadUrl, buildTrackS3Key, buildTranscriptS3Key } from "../../services/s3.ts";
import { parseTrackFilename, inferSessions } from "../../services/track-parser.ts";
import { presignUploadSchema } from "../../lib/schemas.ts";
import {
  createVideo,
  deleteVideo,
  getVideoMeta,
  buildTusCredentials,
} from "../../services/bunny.ts";
import { AppError } from "../../lib/errors.ts";

const uploadRoutes = new Hono();

/**
 * POST /api/admin/upload/presign - Generate presigned upload URLs
 */
uploadRoutes.post("/presign", async (c) => {
  const body = await c.req.json();
  const data = presignUploadSchema.parse(body);

  const urls = await Promise.all(
    data.files.map(async (file) => {
      const s3Key = buildTrackS3Key(data.eventCode, data.sessionNumber, file.filename);
      const uploadUrl = await generatePresignedUploadUrl(s3Key, file.contentType);
      return {
        filename: file.filename,
        s3Key,
        uploadUrl,
      };
    }),
  );

  return c.json({ urls });
});

/**
 * POST /api/admin/upload/presign-transcript - Generate presigned upload URL for transcript
 */
uploadRoutes.post("/presign-transcript", async (c) => {
  const { eventCode, filename, contentType } = (await c.req.json()) as {
    eventCode: string;
    filename: string;
    contentType: string;
  };

  const s3Key = buildTranscriptS3Key(eventCode, filename);
  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

/**
 * POST /api/admin/upload/infer-sessions - Parse filenames and infer sessions
 * Used by admin UI to preview session structure before creating retreat
 */
uploadRoutes.post("/infer-sessions", async (c) => {
  const { filenames } = (await c.req.json()) as { filenames: string[] };

  const parsed = filenames.map(parseTrackFilename);
  const originals = parsed.filter((t) => !t.isTranslation);
  const translations = parsed.filter((t) => t.isTranslation);
  const sessions = inferSessions(originals);

  return c.json({
    sessions,
    translations,
    totalTracks: parsed.length,
    originalTracks: originals.length,
    translationTracks: translations.length,
  });
});

/**
 * POST /api/admin/upload/bunny/create
 * Create a video entry in Bunny Stream and return resumable-upload (TUS) credentials.
 *
 * The admin browser then uses tus-js-client to upload the file directly to Bunny —
 * the API key never leaves the server.
 *
 * Body: { title: string }
 * Returns: { videoId, endpoint, libraryId, signature, expirationTime }
 */
uploadRoutes.post("/bunny/create", async (c) => {
  const body = (await c.req.json()) as { title?: unknown };
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    throw AppError.badRequest("title is required");
  }
  const { guid } = await createVideo(body.title.trim());
  const creds = buildTusCredentials(guid);
  return c.json(creds);
});

/**
 * GET /api/admin/upload/bunny/:videoId
 * Return Bunny's metadata for a video — used to poll until transcoding finishes
 * (status >= 4) so we can save duration + thumbnail on the track row.
 */
uploadRoutes.get("/bunny/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  if (!videoId) throw AppError.badRequest("videoId is required");
  const meta = await getVideoMeta(videoId);
  return c.json({
    guid: meta.guid,
    title: meta.title,
    status: meta.status, // 4 = finished, 5 = error
    durationSeconds: meta.length,
    width: meta.width,
    height: meta.height,
    framerate: meta.framerate,
    thumbnailFileName: meta.thumbnailFileName,
  });
});

/**
 * DELETE /api/admin/upload/bunny/:videoId
 * Remove a video from Bunny Stream. Used when an upload fails before the
 * track row is saved, or when an admin deletes a track row that already had
 * a Bunny video attached. Idempotent: 404 from Bunny is treated as success.
 */
uploadRoutes.delete("/bunny/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  if (!videoId) throw AppError.badRequest("videoId is required");
  await deleteVideo(videoId);
  return c.json({ ok: true });
});

export { uploadRoutes };
