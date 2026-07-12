import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { sessionVideos } from "../../db/schema/session-videos.ts";
import { events } from "../../db/schema/retreats.ts";
import { sessionSubtitles } from "../../db/schema/session-subtitles.ts";
import { createSessionSchema, updateSessionSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { bumpVersion } from "../../services/sync-versions.ts";
import { submitSubtitleJob, getSubtitleJobs, getSessionSubtitles } from "../../services/subtitles.ts";
import { getObjectText, putObject } from "../../services/s3.ts";
import { translateSubtitles } from "../../services/subtitle-translate.ts";
import { isAllowedModel, DEFAULT_TRANSLATE_MODEL } from "../../services/translation-models.ts";
import { addCaption } from "../../services/bunny-captions.ts";

const sessionRoutes = new Hono();

const columns: Record<string, any> = {
  id: sessions.id,
  eventId: sessions.eventId,
  sessionNumber: sessions.sessionNumber,
  sessionDate: sessions.sessionDate,
  timePeriod: sessions.timePeriod,
  createdAt: sessions.createdAt,
};

sessionRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  // Optional filter by event
  const eventId = c.req.query("eventId");
  const where = eventId
    ? eq(sessions.eventId, parseInt(eventId, 10))
    : undefined;

  const [data, total] = await Promise.all([
    db.query.sessions.findMany({
      where,
      orderBy: orderBy ? [orderBy] : undefined,
      limit,
      offset,
      with: {
        tracks: true,
        videos: { orderBy: (v: any, { asc }: any) => [asc(v.position)] },
      },
    }),
    countRows(sessions, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "sessions");
});

sessionRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, id),
    with: {
      tracks: true,
      videos: { orderBy: (v: any, { asc }: any) => [asc(v.position)] },
    },
  });
  if (!session) throw AppError.notFound("Session not found");
  return c.json(session);
});

sessionRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createSessionSchema.parse(body);
  const [session] = await db.insert(sessions).values(data).returning();
  await db
    .update(events)
    .set({ updatedAt: new Date() })
    .where(eq(events.id, session!.eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(session!, 201);
});

sessionRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateSessionSchema.parse(body);

  const [session] = await db
    .update(sessions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sessions.id, id))
    .returning();
  if (!session) throw AppError.notFound("Session not found");

  await db
    .update(events)
    .set({ updatedAt: new Date() })
    .where(eq(events.id, session.eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(session);
});

// Note: Bunny video cleanup no longer happens here — videos are managed via
// the dedicated /admin/session-videos CRUD, which does its own ref-counted
// deletion against session_videos.bunnyVideoId. Deleting a session cascades
// its session_videos rows at the DB level (ON DELETE CASCADE); their Bunny
// assets are not cleaned up by this handler.
sessionRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [session] = await db
    .delete(sessions)
    .where(eq(sessions.id, id))
    .returning();
  if (!session) throw AppError.notFound("Session not found");

  await db
    .update(events)
    .set({ updatedAt: new Date() })
    .where(eq(events.id, session.eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(session);
});

// ── Subtitles ─────────────────────────────────────────────────────────

/**
 * POST /admin/sessions/:id/subtitles
 *
 * Trigger subtitle generation for a session.
 * Submits an AWS Batch job that runs Whisper on the session video.
 */
sessionRoutes.post("/:id/subtitles", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json().catch(() => ({}));
  const result = await submitSubtitleJob(id, {
    language: body.language,
    whisperModel: body.whisperModel,
  });
  return c.json(result, 202);
});

/**
 * GET /admin/sessions/:id/subtitles
 *
 * Get recent subtitle jobs and existing subtitle tracks for a session.
 */
sessionRoutes.get("/:id/subtitles", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [jobs, subtitles] = await Promise.all([
    getSubtitleJobs(id),
    getSessionSubtitles(id),
  ]);
  return c.json({ jobs, subtitles });
});

/**
 * GET /admin/sessions/:id/subtitles/:lang/download
 *
 * Download the VTT file for a session subtitle track.
 */
sessionRoutes.get("/:id/subtitles/:lang/download", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const lang = c.req.param("lang");
  const subs = await getSessionSubtitles(id);
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
 * POST /admin/sessions/:id/subtitles/:lang/translate
 *
 * Trigger translation of English subtitles into the given target language.
 * Returns immediately (202) — the panel polls subtitle_jobs.
 */
sessionRoutes.post("/:id/subtitles/:lang/translate", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const lang = c.req.param("lang");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const model =
    typeof body.model === "string" && isAllowedModel(body.model)
      ? body.model
      : DEFAULT_TRANSLATE_MODEL;
  // Fire-and-forget — the job row tracks status; the panel polls.
  translateSubtitles(id, lang, model).catch((e) =>
    console.error("translateSubtitles failed", e),
  );
  return c.json({ status: "processing", language: lang, model }, 202);
});

/**
 * PUT /admin/sessions/:id/subtitles/:lang
 *
 * Replace a subtitle track with a human-verified VTT file (raw text body).
 * If the English source is replaced, translations are marked stale.
 */
sessionRoutes.put("/:id/subtitles/:lang", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const lang = c.req.param("lang");
  const vtt = await c.req.text();
  if (!vtt.startsWith("WEBVTT")) return c.json({ error: "Not a WebVTT file" }, 400);

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!session) return c.json({ error: "Session not found" }, 404);

  const event = await db.query.events.findFirst({ where: eq(events.id, session.eventId) });
  if (!event) return c.json({ error: "Event not found" }, 404);

  const s3Key = `events/${event.eventCode}/subtitles/${session.sessionNumber}/${lang}.vtt`;
  await putObject(s3Key, Buffer.from(vtt), "text/vtt");

  const existing = await db.query.sessionSubtitles.findFirst({
    where: and(eq(sessionSubtitles.sessionId, id), eq(sessionSubtitles.language, lang)),
  });

  await db
    .insert(sessionSubtitles)
    .values({
      sessionId: id,
      language: lang,
      label: existing?.label ?? lang,
      s3Key,
      origin: existing?.origin ?? (lang === "en" ? "transcription" : "translation"),
      source: "human",
    })
    .onConflictDoUpdate({
      target: [sessionSubtitles.sessionId, sessionSubtitles.language],
      set: { s3Key, source: "human", stale: false, updatedAt: new Date() },
    });

  // TODO(multi-video-subtitles): human-verified VTT is only ever uploaded to
  // the primary (position 0) session_video's captions.
  const video = await db.query.sessionVideos.findFirst({
    where: eq(sessionVideos.sessionId, id),
    orderBy: (v, { asc }) => [asc(v.position)],
  });
  if (video?.bunnyVideoId) {
    await addCaption(video.bunnyVideoId, lang, existing?.label ?? lang, vtt);
  }

  // If the English source changed, mark all translations stale.
  if (lang === "en") {
    await db
      .update(sessionSubtitles)
      .set({ stale: true, updatedAt: new Date() })
      .where(
        and(
          eq(sessionSubtitles.sessionId, id),
          eq(sessionSubtitles.origin, "translation"),
        ),
      );
  }

  return c.json({ ok: true, s3Key });
});

export { sessionRoutes };
