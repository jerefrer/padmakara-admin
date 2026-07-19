import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessionVideos } from "../../db/schema/session-videos.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { events } from "../../db/schema/retreats.ts";
import { sessionSubtitles } from "../../db/schema/session-subtitles.ts";
import {
  createSessionVideoSchema,
  updateSessionVideoSchema,
  importSessionVideoUrlSchema,
} from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, listResponse, countRows } from "./helpers.ts";
import { deleteVideo, fetchVideo } from "../../services/bunny.ts";
import {
  parseOwnS3Key,
  resolveVideoSourceUrl,
  validateDriveFile,
} from "../../services/drive-url.ts";
import { generatePresignedDownloadUrl } from "../../services/s3.ts";
import { config } from "../../config.ts";
import { bumpVersion } from "../../services/sync-versions.ts";
import {
  submitSubtitleJob,
  getSubtitleJobsForVideo,
  getVideoSubtitles,
} from "../../services/subtitles.ts";
import { getObjectText, putObject } from "../../services/s3.ts";
import { translateSubtitles } from "../../services/subtitle-translate.ts";
import { isAllowedModel, DEFAULT_TRANSLATE_MODEL } from "../../services/translation-models.ts";
import { addCaption } from "../../services/bunny-captions.ts";

const sessionVideoRoutes = new Hono();

/**
 * Touch the parent event's updatedAt and bump the events sync version so
 * clients pick up the change. Mirrors the pattern used by tracks/sessions.
 */
async function touchParentEvent(sessionId: number) {
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (session) {
    await db
      .update(events)
      .set({ updatedAt: new Date() })
      .where(eq(events.id, session.eventId));
  }
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
}

/**
 * GET /?sessionId= — list a session's videos ordered by position.
 */
sessionVideoRoutes.get("/", async (c) => {
  const { limit, offset } = parsePagination(c);

  const sessionId = c.req.query("sessionId");
  const where = sessionId
    ? eq(sessionVideos.sessionId, parseInt(sessionId, 10))
    : undefined;

  const [data, total] = await Promise.all([
    db.query.sessionVideos.findMany({
      where,
      orderBy: (v, { asc }) => [asc(v.position)],
      limit,
      offset,
    }),
    countRows(sessionVideos, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "session-videos");
});

sessionVideoRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const video = await db.query.sessionVideos.findFirst({ where: eq(sessionVideos.id, id) });
  if (!video) throw AppError.notFound("Session video not found");
  return c.json(video);
});

sessionVideoRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createSessionVideoSchema.parse(body);
  const [video] = await db.insert(sessionVideos).values(data).returning();
  await touchParentEvent(video!.sessionId);
  return c.json(video!, 201);
});

/**
 * POST /import-url — import a video from a pasted URL.
 *
 * Accepts a Google Drive share link (rewritten to a direct-download URL —
 * the file must be shared as "Anyone with the link") or any public http(s)
 * URL pointing directly at a video file. The download itself happens on
 * Bunny's servers via their /videos/fetch API; this endpoint just creates
 * the Bunny video and the session_videos row. Transcoding progress arrives
 * later through the Bunny webhook (which also backfills durationSeconds).
 */
sessionVideoRoutes.post("/import-url", async (c) => {
  const body = importSessionVideoUrlSchema.parse(await c.req.json());

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, body.sessionId) });
  if (!session) throw AppError.notFound("Session not found");

  const resolved = resolveVideoSourceUrl(body.url);

  // URLs pointing at our own (private) S3 bucket can't be fetched raw —
  // presign the key so Bunny's downloader gets access. 12h leaves plenty of
  // headroom for Bunny's fetch queue.
  let sourceUrl = resolved.sourceUrl;
  const ownS3Key = parseOwnS3Key(body.url);
  if (ownS3Key) {
    sourceUrl = await generatePresignedDownloadUrl(ownS3Key, 12 * 3600);
  }

  // Row title: explicit title > Drive filename > URL filename > null
  // (null → the admin panel derives "Part N" from position).
  let title = body.title ?? null;
  if (resolved.driveFileId) {
    if (config.google.apiKey) {
      // Validates existence + public sharing up front so the admin gets an
      // immediate, actionable error instead of a silent Bunny fetch failure.
      const meta = await validateDriveFile(resolved.driveFileId);
      if (!title) title = meta.name.replace(/\.[^.]+$/, "");
    }
  } else if (!title) {
    const lastSegment = decodeURIComponent(
      new URL(body.url).pathname.split("/").filter(Boolean).pop() ?? "",
    );
    if (lastSegment) title = lastSegment.replace(/\.[^.]+$/, "") || null;
  }

  const existing = await db.query.sessionVideos.findMany({
    where: eq(sessionVideos.sessionId, body.sessionId),
  });
  const position = existing.reduce((max, v) => Math.max(max, v.position + 1), 0);

  let guid: string;
  try {
    ({ guid } = await fetchVideo(sourceUrl, title ?? "Imported video"));
  } catch (err) {
    // Bunny rejected the fetch (private origin, 404, unsupported redirect…).
    // Surface it as an actionable admin-facing error instead of a bare 500.
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError(
      502,
      `Bunny could not fetch the video from this URL — check that it is publicly downloadable. (${detail})`,
      "BUNNY_FETCH_FAILED",
    );
  }

  const [video] = await db
    .insert(sessionVideos)
    .values({ sessionId: body.sessionId, bunnyVideoId: guid, position, title })
    .returning();
  await touchParentEvent(video!.sessionId);
  return c.json(video!, 201);
});

sessionVideoRoutes.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const parsed = updateSessionVideoSchema.parse(body);
  const data: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(parsed)) {
    if (val !== undefined) data[key] = val;
  }
  const [video] = await db
    .update(sessionVideos)
    .set(data)
    .where(eq(sessionVideos.id, id))
    .returning();
  if (!video) throw AppError.notFound("Session video not found");
  await touchParentEvent(video.sessionId);
  return c.json(video);
});

/**
 * DELETE /:id — remove the row and, if no other session_videos row still
 * references the same Bunny GUID, delete the Bunny video too. A GUID can be
 * shared across rows when the same source recording is attached to more
 * than one session (mirrors the old per-session ref-counted cleanup).
 */
sessionVideoRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [video] = await db
    .delete(sessionVideos)
    .where(eq(sessionVideos.id, id))
    .returning();
  if (!video) throw AppError.notFound("Session video not found");

  const stillReferenced = await db.query.sessionVideos.findFirst({
    where: and(
      eq(sessionVideos.bunnyVideoId, video.bunnyVideoId),
      ne(sessionVideos.id, video.id),
    ),
  });
  if (!stillReferenced) {
    deleteVideo(video.bunnyVideoId).catch((err) => {
      console.error(`Failed to delete Bunny video ${video.bunnyVideoId}:`, err);
    });
  } else {
    console.log(
      `[session-videos] Keeping Bunny video ${video.bunnyVideoId} — still referenced by session_video ${stillReferenced.id}`,
    );
  }

  await touchParentEvent(video.sessionId);
  return c.json(video);
});

// ── Subtitles ─────────────────────────────────────────────────────────

/**
 * POST /admin/session-videos/:videoId/subtitles
 *
 * Trigger subtitle generation for a session_video.
 * Submits an AWS Batch job that runs Whisper on this video's audio.
 */
sessionVideoRoutes.post("/:videoId/subtitles", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const body = await c.req.json().catch(() => ({}));
  const result = await submitSubtitleJob(videoId, {
    language: body.language,
    whisperModel: body.whisperModel,
  });
  return c.json(result, 202);
});

/**
 * GET /admin/session-videos/:videoId/subtitles
 *
 * Get recent subtitle jobs and existing subtitle tracks for a session_video.
 */
sessionVideoRoutes.get("/:videoId/subtitles", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const [jobs, subtitles] = await Promise.all([
    getSubtitleJobsForVideo(videoId),
    getVideoSubtitles(videoId),
  ]);
  return c.json({ jobs, subtitles });
});

/**
 * GET /admin/session-videos/:videoId/subtitles/:lang/download
 *
 * Download the VTT file for a session_video's subtitle track.
 */
sessionVideoRoutes.get("/:videoId/subtitles/:lang/download", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  const subs = await getVideoSubtitles(videoId);
  const sub = subs.find((s) => s.language === lang);
  if (!sub) return c.json({ error: "Not found" }, 404);
  const vtt = await getObjectText(sub.s3Key);
  return new Response(vtt, {
    headers: {
      "Content-Type": "text/vtt",
      "Content-Disposition": `attachment; filename="${lang}.vtt"`,
    },
  });
});

/**
 * POST /admin/session-videos/:videoId/subtitles/:lang/translate
 *
 * Trigger translation of English subtitles into the given target language.
 * Returns immediately (202) — the panel polls subtitle_jobs.
 */
sessionVideoRoutes.post("/:videoId/subtitles/:lang/translate", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const model =
    typeof body.model === "string" && isAllowedModel(body.model)
      ? body.model
      : DEFAULT_TRANSLATE_MODEL;
  // Fire-and-forget — the job row tracks status; the panel polls.
  translateSubtitles(videoId, lang, model).catch((e) =>
    console.error("translateSubtitles failed", e),
  );
  return c.json({ status: "processing", language: lang, model }, 202);
});

/**
 * PUT /admin/session-videos/:videoId/subtitles/:lang
 *
 * Replace a subtitle track with a human-verified VTT file (raw text body).
 * If the English source is replaced, that video's translations are marked
 * stale.
 */
sessionVideoRoutes.put("/:videoId/subtitles/:lang", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  const vtt = await c.req.text();
  if (!vtt.startsWith("WEBVTT")) return c.json({ error: "Not a WebVTT file" }, 400);

  const video = await db.query.sessionVideos.findFirst({ where: eq(sessionVideos.id, videoId) });
  if (!video) return c.json({ error: "Session video not found" }, 404);

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, video.sessionId) });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const event = await db.query.events.findFirst({ where: eq(events.id, session.eventId) });
  if (!event) return c.json({ error: "Event not found" }, 404);

  const s3Key = `events/${event.eventCode}/subtitles/s${session.sessionNumber}/v${videoId}/${lang}.vtt`;
  await putObject(s3Key, Buffer.from(vtt), "text/vtt");

  const existing = await db.query.sessionSubtitles.findFirst({
    where: and(eq(sessionSubtitles.sessionVideoId, videoId), eq(sessionSubtitles.language, lang)),
  });

  await db
    .insert(sessionSubtitles)
    .values({
      sessionId: session.id,
      sessionVideoId: videoId,
      language: lang,
      label: existing?.label ?? lang,
      s3Key,
      origin: existing?.origin ?? (lang === "en" ? "transcription" : "translation"),
      source: "human",
    })
    .onConflictDoUpdate({
      target: [sessionSubtitles.sessionVideoId, sessionSubtitles.language],
      set: { s3Key, source: "human", stale: false, updatedAt: new Date() },
    });

  if (video.bunnyVideoId) {
    await addCaption(video.bunnyVideoId, lang, existing?.label ?? lang, vtt);
  }

  // If the English source changed, mark all this video's translations stale.
  if (lang === "en") {
    await db
      .update(sessionSubtitles)
      .set({ stale: true, updatedAt: new Date() })
      .where(
        and(
          eq(sessionSubtitles.sessionVideoId, videoId),
          eq(sessionSubtitles.origin, "translation"),
        ),
      );
  }

  return c.json({ ok: true, s3Key });
});

export { sessionVideoRoutes };
