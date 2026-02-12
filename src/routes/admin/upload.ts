import { Hono } from "hono";
import { generatePresignedUploadUrl, buildTrackS3Key, buildTranscriptS3Key } from "../../services/s3.ts";
import { parseTrackFilename, inferSessions } from "../../services/track-parser.ts";
import { presignUploadSchema } from "../../lib/schemas.ts";

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

export { uploadRoutes };
