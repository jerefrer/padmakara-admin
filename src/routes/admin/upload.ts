import { Hono } from "hono";
import { db } from "../../db/index.ts";
import {
  generatePresignedUploadUrl,
  buildTrackS3Key,
  buildTranscriptS3Key,
  buildEventFileS3Key,
  createMultipartUpload,
  generatePresignedPartUrl,
  listUploadedParts,
  completeMultipartUpload,
  abortMultipartUpload,
} from "../../services/s3.ts";
import {
  planParts,
  isVideoMasterKey,
  isTrackAudioKey,
  contiguousParts,
  AUDIO_PART_SIZE,
} from "../../lib/video-multipart.ts";
import {
  createVideoMultipartSchema,
  createAudioMultipartSchema,
  presignVideoPartsSchema,
  completeVideoMultipartSchema,
  abortVideoMultipartSchema,
  listVideoPartsSchema,
  presignUploadSchema,
  presignTranscriptSchema,
  presignFileSchema,
  presignVideoMasterSchema,
  aiAssistSchema,
} from "../../lib/schemas.ts";
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
 * POST /api/admin/upload/video/presign — presigned PUT for a video master
 * recording (the pre-burn source file for the slide burn-in pipeline).
 *
 * Unlike the audio/document presign routes, this goes straight to S3 rather
 * than Bunny: masters are retained (event_videos.master_s3_key) so a slide
 * edit can re-burn without re-uploading, and the burn container needs S3
 * access to the source file anyway.
 */
uploadRoutes.post("/video/presign", async (c) => {
  const parsed = presignVideoMasterSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const { eventCode, filename, contentType } = parsed.data;
  const s3Key = `events/${eventCode}/masters/${Date.now()}-${filename}`;
  // 12h TTL — masters are multi-GB, so the browser PUT can run for hours on
  // a slow connection. Mirrors the reasoning behind bunny/create's 48h TTL
  // below: the signature must outlive the whole upload, not just the start
  // of it, or a late-stage hiccup turns into an unrecoverable 403.
  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType, 12 * 3600);
  return c.json({ s3Key, uploadUrl });
});

/**
 * Multipart variant of the master upload. A single presigned PUT is capped at
 * 5 GB by S3, so large masters are sent as parts: create → presign-parts (in
 * batches) → complete, or abort. The key is built exactly like /video/presign.
 */
uploadRoutes.post("/video/multipart/create", async (c) => {
  const parsed = createVideoMultipartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const { eventCode, filename, contentType, size } = parsed.data;
  const s3Key = `events/${eventCode}/masters/${Date.now()}-${filename}`;
  const { partSize, partCount } = planParts(size);
  const uploadId = await createMultipartUpload(s3Key, contentType);
  return c.json({ uploadId, s3Key, partSize, partCount });
});

/**
 * Track audio goes up in parts too, so a dropped connection on a slow line
 * costs one 8 MiB part instead of restarting the whole recording. Same key
 * as the single-PUT /presign route.
 */
uploadRoutes.post("/audio/multipart/create", async (c) => {
  const parsed = createAudioMultipartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const { eventCode, filename, contentType, size } = parsed.data;
  const s3Key = buildTrackS3Key(eventCode, 0, filename);
  const { partSize, partCount } = planParts(size, AUDIO_PART_SIZE);
  const uploadId = await createMultipartUpload(s3Key, contentType);
  return c.json({ uploadId, s3Key, partSize, partCount });
});

/**
 * The part routes shared by both kinds of multipart upload: presign-parts (in
 * batches) → complete, list-parts to resume, or abort. `isAllowedKey` limits
 * each prefix to the keys its own create route produces, so they never sign
 * arbitrary keys in the bucket.
 */
function registerPartRoutes(prefix: string, isAllowedKey: (key: string) => boolean): void {
  uploadRoutes.post(`${prefix}/presign-parts`, async (c) => {
    const parsed = presignVideoPartsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
    }
    const { s3Key, uploadId, partNumbers } = parsed.data;
    if (!isAllowedKey(s3Key)) throw AppError.badRequest("Invalid s3Key", "INVALID_S3_KEY");
    const entries = await Promise.all(
      partNumbers.map(
        async (n) => [n, await generatePresignedPartUrl(s3Key, uploadId, n, 6 * 3600)] as const,
      ),
    );
    return c.json({ urls: Object.fromEntries(entries) });
  });

  /**
   * Completes by listing the parts S3 holds instead of trusting ETags from the
   * browser (the bucket CORS may not expose the ETag header).
   */
  uploadRoutes.post(`${prefix}/complete`, async (c) => {
    const parsed = completeVideoMultipartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
    }
    const { s3Key, uploadId } = parsed.data;
    if (!isAllowedKey(s3Key)) throw AppError.badRequest("Invalid s3Key", "INVALID_S3_KEY");
    const parts = contiguousParts(await listUploadedParts(s3Key, uploadId));
    if (!parts) {
      throw AppError.badRequest(
        "Uploaded parts are missing or not contiguous from part 1",
        "INCOMPLETE_UPLOAD",
      );
    }
    await completeMultipartUpload(s3Key, uploadId, parts);
    return c.json({ s3Key });
  });

  /**
   * Parts S3 already holds for an in-progress upload, so a reloaded or
   * discarded tab can resume instead of starting over. 404 NO_SUCH_UPLOAD when
   * S3 no longer knows the upload (aborted, completed or expired).
   */
  uploadRoutes.post(`${prefix}/list-parts`, async (c) => {
    const parsed = listVideoPartsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
    }
    const { s3Key, uploadId } = parsed.data;
    if (!isAllowedKey(s3Key)) throw AppError.badRequest("Invalid s3Key", "INVALID_S3_KEY");
    let listed: Awaited<ReturnType<typeof listUploadedParts>>;
    try {
      listed = await listUploadedParts(s3Key, uploadId);
    } catch (err) {
      if (err instanceof Error && err.name === "NoSuchUpload") {
        throw new AppError(404, "Multipart upload not found", "NO_SUCH_UPLOAD");
      }
      throw err;
    }
    return c.json({
      parts: listed.map((p) => ({ partNumber: p.partNumber, size: p.size, etag: p.etag })),
    });
  });

  uploadRoutes.post(`${prefix}/abort`, async (c) => {
    const parsed = abortVideoMultipartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
    }
    const { s3Key, uploadId } = parsed.data;
    if (!isAllowedKey(s3Key)) throw AppError.badRequest("Invalid s3Key", "INVALID_S3_KEY");
    await abortMultipartUpload(s3Key, uploadId);
    return c.json({ ok: true });
  });
}

registerPartRoutes("/video/multipart", isVideoMasterKey);
registerPartRoutes("/audio/multipart", isTrackAudioKey);

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
