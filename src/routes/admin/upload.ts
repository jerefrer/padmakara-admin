import { Hono } from "hono";
import { db } from "../../db/index.ts";
import { generatePresignedUploadUrl, buildTrackS3Key, buildTranscriptS3Key, buildEventFileS3Key } from "../../services/s3.ts";
import { presignUploadSchema, presignTranscriptSchema, presignFileSchema, aiAssistSchema } from "../../lib/schemas.ts";
import {
  createVideo,
  deleteVideo,
  getVideoMeta,
  buildTusCredentials,
} from "../../services/bunny.ts";
import { AppError } from "../../lib/errors.ts";
import { aiAssistEvent } from "../../services/ai-assist.ts";

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
  const parsed = presignTranscriptSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }

  const { eventCode, filename, contentType } = parsed.data;
  const s3Key = buildTranscriptS3Key(eventCode, filename);
  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

/**
 * POST /api/admin/upload/presign-file — presigned PUT for a generic document.
 */
uploadRoutes.post("/presign-file", async (c) => {
  const parsed = presignFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const { eventCode, filename, contentType, fileType } = parsed.data;
  const s3Key = buildEventFileS3Key(eventCode, fileType, filename);
  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);
  return c.json({ s3Key, uploadUrl });
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
  // 48h signature TTL — Bunny validates it on every TUS request, so it must
  // outlive the WHOLE upload. With the 1h default, a 10.5 GB upload died at
  // ~70%: first connection hiccup past the hour → 401 on resume → 409 offset
  // conflict → retries exhausted → partial upload deleted by cleanup.
  const creds = buildTusCredentials(guid, 48 * 3600);
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

/**
 * POST /api/admin/upload/rename-tracks
 *
 * Stateless variant of the rename-tracks AI endpoint for the EventCreate flow
 * (before an event ID exists). Accepts the same body and returns the same
 * { event?, sessions, tracks } shape as POST /admin/events/:id/rename-tracks.
 */
uploadRoutes.post("/rename-tracks", async (c) => {
  const parsed = aiAssistSchema.safeParse(await c.req.json().catch(() => null));
  // Rethrow the ZodError itself rather than a bare AppError: errorHandler
  // renders its `issues` (path + message), which is the only way to tell
  // which field of a 200-track payload was rejected.
  if (!parsed.success) throw parsed.error;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const roster = await db.query.teachers.findMany({
    columns: { abbreviation: true, name: true },
  });
  const result = await aiAssistEvent({ ...parsed.data, roster, apiKey });
  return c.json(result);
});

export { uploadRoutes };
