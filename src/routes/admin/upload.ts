import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { generatePresignedUploadUrl, buildTrackS3Key, buildTranscriptS3Key } from "../../services/s3.ts";
import { parseTrackFilename, inferSessions } from "../../services/track-parser.ts";
import { presignUploadSchema, presignTranscriptSchema, inferSessionsSchema, renameTracksSchema } from "../../lib/schemas.ts";
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
 * POST /api/admin/upload/infer-sessions - Parse filenames and infer sessions
 * Used by admin UI to preview session structure before creating retreat
 */
uploadRoutes.post("/infer-sessions", async (c) => {
  const parsed = inferSessionsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }

  const { filenames } = parsed.data;
  const tracks = filenames.map(parseTrackFilename);
  const originals = tracks.filter((t) => !t.isTranslation);
  const translations = tracks.filter((t) => t.isTranslation);
  const sessions = inferSessions(originals);

  return c.json({
    sessions,
    translations,
    totalTracks: tracks.length,
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

/**
 * POST /api/admin/upload/rename-tracks
 *
 * Stateless variant of the rename-tracks AI endpoint for the EventCreate flow
 * (before an event ID exists). Accepts the same body and returns the same
 * { suggestions } shape as POST /admin/events/:id/rename-tracks.
 */
uploadRoutes.post("/rename-tracks", async (c) => {
  const parsed = renameTracksSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw AppError.internal("ANTHROPIC_API_KEY not configured");
  }

  const { instruction, rows } = parsed.data;
  const anthropic = new Anthropic({ apiKey });
  const rowsJson = JSON.stringify(rows, null, 2);

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `You are helping a Buddhist retreat administrator clean up audio track titles for a content management system. You will receive a list of track rows and a plain-English instruction. Apply the instruction to the rows and return suggested edits as a JSON array. Each element has "rowKey" (unchanged) and optionally "title" and/or "speaker" with the suggested new values. Only include fields that should change. Return only the JSON array, no markdown fences, no prose.`,
    messages: [
      {
        role: "user",
        content: `Instruction: ${instruction}\n\nRows:\n${rowsJson}`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  let responseText = textBlock.text.trim();
  if (responseText.startsWith("```")) {
    responseText = responseText
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  }

  let suggestions: { rowKey: string; title?: string; speaker?: string }[];
  try {
    const raw: unknown = JSON.parse(responseText);
    if (!Array.isArray(raw)) throw new Error("Expected array");
    suggestions = raw.map((item: unknown) => {
      if (typeof item !== "object" || item === null) throw new Error("Bad item");
      const s = item as Record<string, unknown>;
      const out: { rowKey: string; title?: string; speaker?: string } = {
        rowKey: String(s.rowKey ?? ""),
      };
      if (typeof s.title === "string") out.title = s.title;
      if (typeof s.speaker === "string") out.speaker = s.speaker;
      return out;
    });
  } catch {
    throw AppError.internal("Failed to parse AI rename response");
  }

  return c.json({ suggestions });
});

export { uploadRoutes };
