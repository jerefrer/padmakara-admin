import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { eventVideos } from "../../db/schema/event-videos.ts";
import { events } from "../../db/schema/retreats.ts";
import { videoSubtitles } from "../../db/schema/video-subtitles.ts";
import {
  burnVideoSchema,
  createEventVideoSchema,
  updateEventVideoSchema,
  importEventVideoUrlSchema,
  putEventVideoSlidesSchema,
  slideImageUrlsSchema,
} from "../../lib/schemas.ts";
import { buildDefaultSlideDocument, isBuiltinKey } from "../../lib/slides/defaults.ts";
import { AppError } from "../../lib/errors.ts";
import { submitVideoBurnJob } from "../../services/video-burn.ts";
import { fetchSlideTemplateMetadata } from "../../services/slide-metadata.ts";
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
  getSubtitleJobsForVideo,
  getVideoSubtitles,
} from "../../services/subtitles.ts";
import { getObjectText, putObject } from "../../services/s3.ts";
import { translateSubtitles } from "../../services/subtitle-translate.ts";
import { isAllowedModel, DEFAULT_TRANSLATE_MODEL } from "../../services/translation-models.ts";
import { addCaption } from "../../services/bunny-captions.ts";

const videoRoutes = new Hono();

/**
 * Touch the parent event's updatedAt and bump the events sync version so
 * clients pick up the change. Mirrors the pattern used by tracks/sessions.
 */
async function touchParentEvent(eventId: number) {
  await db
    .update(events)
    .set({ updatedAt: new Date() })
    .where(eq(events.id, eventId));
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
}

/**
 * GET /?eventId= — list an event's videos ordered by position.
 */
videoRoutes.get("/", async (c) => {
  const { limit, offset } = parsePagination(c);

  const eventId = c.req.query("eventId");
  const where = eventId
    ? eq(eventVideos.eventId, parseInt(eventId, 10))
    : undefined;

  const [data, total] = await Promise.all([
    db.query.eventVideos.findMany({
      where,
      orderBy: (v, { asc }) => [asc(v.position)],
      limit,
      offset,
    }),
    countRows(eventVideos, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "videos");
});

videoRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!video) throw AppError.notFound("Event video not found");
  return c.json(video);
});

videoRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createEventVideoSchema.parse(body);
  const [video] = await db.insert(eventVideos).values(data).returning();
  await touchParentEvent(video!.eventId);
  return c.json(video!, 201);
});

/**
 * POST /import-url — import a video from a pasted URL.
 *
 * Accepts a Google Drive share link (rewritten to a direct-download URL —
 * the file must be shared as "Anyone with the link") or any public http(s)
 * URL pointing directly at a video file.
 *
 * Two paths, same as the file-upload gate (see EventVideosSection.tsx /
 * AddVideoDialog.tsx in the admin):
 *
 *  - No slides supplied: the download happens on Bunny's servers via their
 *    /videos/fetch API — this endpoint just creates the Bunny video and the
 *    event_videos row. Transcoding progress arrives later through the Bunny
 *    webhook (which also backfills durationSeconds). Unchanged from before
 *    slide burn-in existed.
 *  - Slides supplied: the URL is handed to the burn container instead of to
 *    Bunny directly (MASTER_SOURCE_URL — see containers/video-burn/source.ts).
 *    The container downloads the file itself, retains the untouched
 *    original in S3 before burning (so re-burns have a first-generation
 *    master), renders the slides around it, and hands the merged file to
 *    Bunny. No Bunny video exists yet when this responds — the completion
 *    webhook supplies bunnyVideoId AND backfills masterS3Key once the
 *    container has retained the original.
 */
videoRoutes.post("/import-url", async (c) => {
  const body = importEventVideoUrlSchema.parse(await c.req.json());

  const event = await db.query.events.findFirst({ where: eq(events.id, body.eventId) });
  if (!event) throw AppError.notFound("Event not found");

  const resolved = resolveVideoSourceUrl(body.url);

  // URLs pointing at our own (private) S3 bucket can't be fetched raw —
  // presign the key so Bunny's/the burn container's downloader gets access.
  // 12h leaves plenty of headroom for either fetch queue.
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

  const existing = await db.query.eventVideos.findMany({
    where: eq(eventVideos.eventId, body.eventId),
  });
  const position = existing.reduce((max, v) => Math.max(max, v.position + 1), 0);

  if (body.slides) {
    const [video] = await db
      .insert(eventVideos)
      .values({
        eventId: body.eventId,
        bunnyVideoId: null,
        position,
        titleEn: title,
        slides: body.slides,
        burnStatus: "pending",
      })
      .returning();
    if (!video) throw AppError.internal("Failed to create the video row");

    try {
      await submitVideoBurnJob({
        videoId: video.id,
        masterSourceUrl: sourceUrl,
        slides: body.slides,
        title: title || `Video ${video.id}`,
      });
      await touchParentEvent(video.eventId);
      return c.json(video, 201);
    } catch (err) {
      // Keep the row — the slides are saved and the source URL is known, so
      // the admin can retry the burn rather than re-pasting the URL.
      const detail = err instanceof Error ? err.message : String(err);
      await db
        .update(eventVideos)
        .set({ burnStatus: "failed", burnError: detail, updatedAt: new Date() })
        .where(eq(eventVideos.id, video.id));
      await touchParentEvent(video.eventId);
      throw new AppError(
        502,
        `The video was imported but its burn job could not be queued — retry from the video list. (${detail})`,
        "BURN_SUBMIT_FAILED",
      );
    }
  }

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
    .insert(eventVideos)
    .values({ eventId: body.eventId, bunnyVideoId: guid, position, titleEn: title ?? null })
    .returning();
  await touchParentEvent(video!.eventId);
  return c.json(video!, 201);
});

/**
 * POST /api/admin/videos/burn
 *
 * The slide burn-in entry point, and the counterpart to the direct-to-Bunny
 * upload above. The browser has already PUT the master to S3; this creates the
 * event_videos row that owns it — master key, slide document, burn status —
 * and queues the AWS Batch job that renders the slides, concatenates them
 * around the master and hands the merged file to Bunny.
 *
 * The row is created with a NULL bunny_video_id on purpose: there is no Bunny
 * video until the completion webhook supplies its guid (see migration 0037).
 *
 * Responds as soon as the job is queued. Merging a feature-length master plus
 * Bunny's re-transcode runs for tens of minutes, which is far too long to hold
 * an upload dialog open; `burnStatus` on the row carries it from here.
 */
videoRoutes.post("/burn", async (c) => {
  const body = burnVideoSchema.parse(await c.req.json());

  const position =
    body.position ?? (await countRows(eventVideos, eq(eventVideos.eventId, body.eventId)));

  const [video] = await db
    .insert(eventVideos)
    .values({
      eventId: body.eventId,
      bunnyVideoId: null,
      position,
      titleEn: body.titleEn ?? null,
      titlePt: body.titlePt ?? null,
      videoDate: body.videoDate ?? null,
      masterS3Key: body.masterS3Key,
      slides: body.slides,
      burnStatus: "pending",
    })
    .returning();
  if (!video) throw AppError.internal("Failed to create the video row");

  const title = body.titleEn || body.titlePt || `Video ${video.id}`;
  try {
    const { jobId } = await submitVideoBurnJob({
      videoId: video.id,
      masterS3Key: body.masterS3Key,
      slides: body.slides,
      title,
    });
    await touchParentEvent(video.eventId);
    return c.json({ videoId: video.id, jobId, burnStatus: "queued" }, 201);
  } catch (err) {
    // Keep the row. The master is uploaded and the slides are saved, so the
    // admin can retry the burn rather than re-uploading multiple gigabytes.
    const detail = err instanceof Error ? err.message : String(err);
    await db
      .update(eventVideos)
      .set({ burnStatus: "failed", burnError: detail, updatedAt: new Date() })
      .where(eq(eventVideos.id, video.id));
    await touchParentEvent(video.eventId);
    throw new AppError(
      502,
      `The video was uploaded but its burn job could not be queued — retry from the video list. (${detail})`,
      "BURN_SUBMIT_FAILED",
    );
  }
});

/**
 * POST /api/admin/videos/:id/reburn
 *
 * Re-run the burn after a slide edit. Reads from the retained master rather
 * than from Bunny, so repeated edits never accumulate generation loss.
 */
videoRoutes.post("/:id/reburn", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!video) throw AppError.notFound("Event video not found");
  if (!video.masterS3Key) {
    throw AppError.conflict(
      "This video has no retained master — it predates the burn pipeline, or was uploaded directly to Bunny",
    );
  }
  if (!video.slides) throw AppError.conflict("This video has no slides defined");
  if (video.burnStatus === "queued" || video.burnStatus === "running") {
    throw AppError.conflict("A burn is already in progress for this video");
  }

  const title = video.titleEn || video.titlePt || `Video ${video.id}`;
  const { jobId } = await submitVideoBurnJob({
    videoId: video.id,
    masterS3Key: video.masterS3Key,
    slides: video.slides,
    title,
  });
  await touchParentEvent(video.eventId);
  return c.json({ videoId: video.id, jobId, burnStatus: "queued" });
});

videoRoutes.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const parsed = updateEventVideoSchema.parse(body);
  const data: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(parsed)) {
    if (val !== undefined) data[key] = val;
  }
  const [video] = await db
    .update(eventVideos)
    .set(data)
    .where(eq(eventVideos.id, id))
    .returning();
  if (!video) throw AppError.notFound("Event video not found");
  await touchParentEvent(video.eventId);
  return c.json(video);
});

/**
 * DELETE /:id — remove the row and, if no other event_videos row still
 * references the same Bunny GUID, delete the Bunny video too. A GUID can be
 * shared across rows when the same source recording is attached more than
 * once (mirrors the old per-session ref-counted cleanup).
 */
videoRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [video] = await db
    .delete(eventVideos)
    .where(eq(eventVideos.id, id))
    .returning();
  if (!video) throw AppError.notFound("Event video not found");

  // A video whose burn never completed has no Bunny video to reference-count
  // or clean up — the master in S3 is the only artifact, and it is retained
  // deliberately so the burn can be re-run.
  const guid = video.bunnyVideoId;
  if (guid) {
    const stillReferenced = await db.query.eventVideos.findFirst({
      where: and(eq(eventVideos.bunnyVideoId, guid), ne(eventVideos.id, video.id)),
    });
    if (!stillReferenced) {
      deleteVideo(guid).catch((err) => {
        console.error(`Failed to delete Bunny video ${guid}:`, err);
      });
    } else {
      console.log(
        `[videos] Keeping Bunny video ${guid} — still referenced by event_video ${stillReferenced.id}`,
      );
    }
  }

  await touchParentEvent(video.eventId);
  return c.json(video);
});

// ── Title slides ─────────────────────────────────────────────────────────

function slidesResponse(video: typeof eventVideos.$inferSelect) {
  return {
    slides: video.slides ?? null,
    hasBurnedSlides: video.hasBurnedSlides,
    burnStatus: video.burnStatus,
    burnError: video.burnError,
    burnedIntroMs: video.burnedIntroMs,
  };
}

/**
 * GET /admin/videos/:id/slides
 */
videoRoutes.get("/:id/slides", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!video) throw AppError.notFound("Event video not found");
  return c.json(slidesResponse(video));
});

/**
 * PUT /admin/videos/:id/slides
 *
 * Replace the slide document. Editing slides on a video whose most recent
 * burn already completed ('done') sets burn_status back to 'pending' — the
 * admin then triggers a re-burn from the retained master.
 */
videoRoutes.put("/:id/slides", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const parsed = putEventVideoSlidesSchema.parse(body);

  const existing = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!existing) throw AppError.notFound("Event video not found");

  const data: Record<string, unknown> = {
    slides: parsed.slides,
    updatedAt: new Date(),
  };
  if (existing.burnStatus === "done") {
    data.burnStatus = "pending";
  }

  const [video] = await db
    .update(eventVideos)
    .set(data)
    .where(eq(eventVideos.id, id))
    .returning();
  if (!video) throw AppError.notFound("Event video not found");
  await touchParentEvent(video.eventId);

  return c.json(slidesResponse(video));
});

/**
 * POST /admin/videos/:id/slides/image-urls
 *
 * Resolve stored slide-document image s3Keys to short-lived presigned GET
 * URLs, so the admin preview can render an image line loaded from an
 * already-saved slide document. Images uploaded during the current editing
 * session are previewed from a local blob URL instead (see SlideEditor.tsx),
 * and builtin `@builtin/` keys resolve client-side — neither needs this
 * endpoint, so this only closes the gap for keys that were saved in a
 * previous session.
 *
 * SECURITY: only keys that literally appear as an image line in THIS
 * video's own stored slide document are ever presigned. Accepting arbitrary
 * caller-supplied keys here would turn this endpoint into an open read
 * oracle for the whole bucket. A requested key that isn't in the document is
 * silently omitted from the response, never treated as an error — the
 * caller's local document may simply be stale.
 */
videoRoutes.post("/:id/slides/image-urls", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const { s3Keys } = slideImageUrlsSchema.parse(await c.req.json());

  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!video) throw AppError.notFound("Event video not found");

  const allowedKeys = new Set<string>();
  for (const slide of [...(video.slides?.intro ?? []), ...(video.slides?.outro ?? [])]) {
    for (const line of slide.lines) {
      if (line.type === "image") allowedKeys.add(line.s3Key);
    }
  }

  const toPresign = [...new Set(s3Keys)].filter((key) => allowedKeys.has(key) && !isBuiltinKey(key));
  const urls: Record<string, string> = {};
  await Promise.all(
    toPresign.map(async (key) => {
      urls[key] = await generatePresignedDownloadUrl(key);
    }),
  );

  return c.json({ urls });
});

/**
 * POST /admin/videos/:id/slides/defaults
 *
 * Generate the default 5-slide intro + logo outro from the event's
 * metadata (teachers, event type, place, date, organizer/credits). Does NOT
 * persist — the admin previews the result client-side and PUTs it (possibly
 * edited) to actually save.
 */
videoRoutes.post("/:id/slides/defaults", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, id) });
  if (!video) throw AppError.notFound("Event video not found");

  const meta = await fetchSlideTemplateMetadata(video.eventId, video.videoDate);
  if (!meta) throw AppError.notFound("Event not found");

  const slides = buildDefaultSlideDocument(meta, () => crypto.randomUUID());
  return c.json({ slides });
});

// ── Subtitles ─────────────────────────────────────────────────────────

/**
 * POST /admin/videos/:videoId/subtitles
 *
 * Trigger subtitle generation for an event_video.
 * Submits an AWS Batch job that runs Whisper on this video's audio.
 */
/**
 * GET /admin/videos/:videoId/subtitles
 *
 * Get recent subtitle jobs and existing subtitle tracks for an event_video.
 */
videoRoutes.get("/:videoId/subtitles", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const [jobs, subtitles] = await Promise.all([
    getSubtitleJobsForVideo(videoId),
    getVideoSubtitles(videoId),
  ]);
  return c.json({ jobs, subtitles });
});

/**
 * GET /admin/videos/:videoId/subtitles/:lang/download
 *
 * Download the VTT file for an event_video's subtitle track.
 */
videoRoutes.get("/:videoId/subtitles/:lang/download", async (c) => {
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
 * POST /admin/videos/:videoId/subtitles/:lang/translate
 *
 * Trigger translation of English subtitles into the given target language.
 * Returns immediately (202) — the panel polls subtitle_jobs.
 */
videoRoutes.post("/:videoId/subtitles/:lang/translate", async (c) => {
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
 * PUT /admin/videos/:videoId/subtitles/:lang
 *
 * Replace a subtitle track with a human-verified VTT file (raw text body).
 * If the English source is replaced, that video's translations are marked
 * stale.
 */
videoRoutes.put("/:videoId/subtitles/:lang", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  const vtt = await c.req.text();
  if (!vtt.startsWith("WEBVTT")) return c.json({ error: "Not a WebVTT file" }, 400);

  const video = await db.query.eventVideos.findFirst({ where: eq(eventVideos.id, videoId) });
  if (!video) return c.json({ error: "Event video not found" }, 404);

  const event = await db.query.events.findFirst({ where: eq(events.id, video.eventId) });
  if (!event) return c.json({ error: "Event not found" }, 404);

  const s3Key = `events/${event.eventCode}/subtitles/v${videoId}/${lang}.vtt`;
  await putObject(s3Key, Buffer.from(vtt), "text/vtt");

  const existing = await db.query.videoSubtitles.findFirst({
    where: and(eq(videoSubtitles.videoId, videoId), eq(videoSubtitles.language, lang)),
  });

  await db
    .insert(videoSubtitles)
    .values({
      videoId,
      language: lang,
      label: existing?.label ?? lang,
      s3Key,
      origin: existing?.origin ?? (lang === "en" ? "transcription" : "translation"),
      source: "human",
    })
    .onConflictDoUpdate({
      target: [videoSubtitles.videoId, videoSubtitles.language],
      set: { s3Key, source: "human", stale: false, updatedAt: new Date() },
    });

  if (video.bunnyVideoId) {
    await addCaption(video.bunnyVideoId, lang, existing?.label ?? lang, vtt);
  }

  // If the English source changed, mark all this video's translations stale.
  if (lang === "en") {
    await db
      .update(videoSubtitles)
      .set({ stale: true, updatedAt: new Date() })
      .where(
        and(
          eq(videoSubtitles.videoId, videoId),
          eq(videoSubtitles.origin, "translation"),
        ),
      );
  }

  return c.json({ ok: true, s3Key });
});

export { videoRoutes };
