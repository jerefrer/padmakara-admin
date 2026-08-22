import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.ts";
import { readAlongJobs } from "../db/schema/read-along-jobs.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { events } from "../db/schema/retreats.ts";
import { subtitleJobs } from "../db/schema/subtitle-jobs.ts";
import { videoSubtitles } from "../db/schema/video-subtitles.ts";
import { config } from "../config.ts";
import { getVideoMeta } from "../services/bunny.ts";
import { addCaption } from "../services/bunny-captions.ts";
import { getObjectText, putObject } from "../services/s3.ts";
import { bumpVersion } from "../services/sync-versions.ts";
import { computeIntroDelta, applyIntroDeltaInTransaction } from "../services/video-burn.ts";

const webhookRoutes = new Hono();

/**
 * POST /api/webhooks/read-along
 *
 * Called by the Batch container when alignment completes (or fails).
 * Validates HMAC-SHA256 signature, updates job record, and sets
 * readAlongS3Key on matching tracks.
 *
 * No auth middleware — public endpoint, HMAC-authenticated.
 */
webhookRoutes.post("/read-along", async (c) => {
  // Verify HMAC signature
  const signature = c.req.header("X-Webhook-Signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const rawBody = await c.req.text();
  const expected = createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const body = JSON.parse(rawBody);
  const { jobId, eventId, eventCode, status, uploadedFiles, summary, error } = body;

  if (!jobId || !status) {
    return c.json({ error: "Missing jobId or status" }, 400);
  }

  console.log(`[webhook] Read-along ${status} for event ${eventCode} (job ${jobId})`);

  // Update job record
  const updates: Record<string, any> = {
    status,
    updatedAt: new Date(),
    completedAt: new Date(),
  };

  if (uploadedFiles) updates.uploadedFiles = uploadedFiles;
  if (summary) updates.summary = summary;
  if (error) updates.errorMessage = error;

  await db
    .update(readAlongJobs)
    .set(updates)
    .where(eq(readAlongJobs.id, jobId));

  // If completed successfully, update tracks with readAlongS3Key
  if (status === "completed" && uploadedFiles) {
    let updated = 0;
    for (const [mp3Name, s3Key] of Object.entries(uploadedFiles)) {
      // Find track by originalFilename (same logic as upload-read-along.ts)
      const track = await db.query.tracks.findFirst({
        where: eq(tracks.originalFilename, mp3Name),
      });

      if (track) {
        await db
          .update(tracks)
          .set({ readAlongS3Key: s3Key as string })
          .where(eq(tracks.id, track.id));
        updated++;
      } else {
        console.warn(`[webhook] No track found for "${mp3Name}"`);
      }
    }
    console.log(`[webhook] Updated ${updated}/${Object.keys(uploadedFiles).length} tracks`);

    // Touch the parent event and bump the events sync version so the app's
    // version-gated sync + no-TTL cache pick up the newly available read-along data.
    await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, eventId));
    bumpVersion("events").catch((e) => console.error("[webhook] bumpVersion failed:", e));
  }

  return c.json({ ok: true });
});

/**
 * POST /api/webhooks/bunny?secret=...
 *
 * Bunny Stream notifies us when a video finishes transcoding (status 4) or
 * fails (status 5). On success we backfill durationSeconds onto the track so
 * the app shows the right time even if the admin closed the upload tab while
 * Bunny was still working.
 *
 * Auth: shared secret in `?secret=` query string, configured server-side as
 * BUNNY_WEBHOOK_SECRET and pasted into the Bunny library's "Webhook URL"
 * setting. We also verify Bunny's HMAC signature header when present.
 *
 * Bunny status codes:
 *   0 created · 1 uploaded · 2 processing · 3 transcoding · 4 finished · 5 error · 6 upload-failed
 */
webhookRoutes.post("/bunny", async (c) => {
  const provided = c.req.query("secret") ?? "";
  const expectedSecret = config.bunny.webhookSecret;

  if (!expectedSecret) {
    return c.json({ error: "Bunny webhook secret not configured" }, 503);
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "Invalid secret" }, 401);
  }

  const rawBody = await c.req.text();

  // Optional HMAC signature check — Bunny signs with the same secret if
  // configured. If the header is absent we accept the request (URL secret is
  // already required) but log it.
  const sig = c.req.header("bunny-signature") ?? c.req.header("x-bunny-signature");
  if (sig) {
    const expected = createHmac("sha256", expectedSecret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  let payload: { VideoGuid?: string; Status?: number; VideoLibraryId?: number };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const videoGuid = payload.VideoGuid;
  const status = payload.Status;
  if (!videoGuid || typeof status !== "number") {
    return c.json({ error: "Missing VideoGuid or Status" }, 400);
  }

  console.log(`[webhook] Bunny status=${status} for video ${videoGuid}`);

  // Only act on terminal states. Intermediate transitions are noise.
  if (status === 4) {
    // Finished — fetch metadata and update the matching event_video row.
    // An event can have several recordings; each is its own event_videos
    // row keyed by its Bunny GUID.
    try {
      const meta = await getVideoMeta(videoGuid);
      const duration = Math.round(meta.length || 0);
      const result = await db
        .update(eventVideos)
        .set({ durationSeconds: duration, updatedAt: new Date() })
        .where(eq(eventVideos.bunnyVideoId, videoGuid))
        .returning({ id: eventVideos.id });
      if (result.length === 0) {
        console.warn(`[webhook] No event_video found for Bunny video ${videoGuid} (orphan or admin still saving)`);
      } else {
        console.log(`[webhook] Updated event_video ${result[0]!.id} durationSeconds=${duration}s`);
      }
    } catch (err) {
      console.error(`[webhook] Failed to fetch metadata for ${videoGuid}:`, err);
      // Still ack — we don't want Bunny to retry forever on a transient fetch failure.
    }
  } else if (status === 5 || status === 6) {
    console.error(`[webhook] Bunny reported failure (status ${status}) for video ${videoGuid}`);
    // Leave the track row alone — admin can investigate via the dashboard.
  }

  return c.json({ ok: true });
});

/**
 * POST /api/webhooks/subtitles
 *
 * Called by the AWS Batch container when a subtitle/caption job finishes
 * (or fails). Validates HMAC-SHA256 signature, updates the subtitleJobs
 * record, and — on success — attributes the job to its event_video via
 * the job row (not the payload, which may be stale), re-homes the
 * container's scratch VTT to the canonical backend-owned per-video S3 key,
 * upserts videoSubtitles, and uploads the VTT to Bunny captions.
 *
 * No auth middleware — public endpoint, HMAC-authenticated.
 */
webhookRoutes.post("/subtitles", async (c) => {
  // Verify HMAC signature
  const signature = c.req.header("X-Webhook-Signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const rawBody = await c.req.text();
  const expected = createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const {
    jobId,
    status,
    language,
    label,
    s3Key,
    summary,
    error,
  } = JSON.parse(rawBody);

  console.log(`[webhook] Subtitles ${status} for job ${jobId}`);

  // Update the subtitle job record
  await db
    .update(subtitleJobs)
    .set({
      status,
      summary: summary ?? null,
      errorMessage: error ?? null,
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(eq(subtitleJobs.id, jobId));

  if (status === "completed" && s3Key) {
    // Trust the job row for attribution — the payload's sessionId (if any)
    // is ignored entirely and may be absent or stale. The job row is the
    // source of truth for which event_video this job belongs to.
    const job = await db.query.subtitleJobs.findFirst({
      where: eq(subtitleJobs.id, jobId),
    });
    if (!job || !job.videoId) {
      console.warn(`[webhook] Subtitle job ${jobId} has no event_video attribution — skipping re-home`);
      return c.json({ ok: true });
    }

    const video = await db.query.eventVideos.findFirst({
      where: eq(eventVideos.id, job.videoId),
    });
    if (!video) {
      console.warn(`[webhook] Subtitle job ${jobId} references missing event_video ${job.videoId}`);
      return c.json({ ok: true });
    }

    const event = await db.query.events.findFirst({
      where: eq(events.id, video.eventId),
    });
    if (!event) {
      console.warn(`[webhook] Subtitle job ${jobId} references missing event ${video.eventId}`);
      return c.json({ ok: true });
    }

    // Re-home the container's scratch VTT to the canonical, backend-owned
    // per-video S3 key.
    const vtt = await getObjectText(s3Key);
    const canonicalKey = `events/${event.eventCode}/subtitles/v${video.id}/${language}.vtt`;
    await putObject(canonicalKey, Buffer.from(vtt), "text/vtt");

    // Upsert the video subtitle row (unique on videoId + language)
    await db
      .insert(videoSubtitles)
      .values({
        videoId: video.id,
        language,
        label: label ?? language,
        s3Key: canonicalKey,
        origin: "transcription",
        source: "auto",
      })
      .onConflictDoUpdate({
        target: [videoSubtitles.videoId, videoSubtitles.language],
        set: {
          s3Key: canonicalKey,
          label: label ?? language,
          source: "auto",
          stale: false,
          updatedAt: new Date(),
        },
      });

    // Translations are made from the English, so regenerating it leaves them
    // describing subtitles that no longer exist. translateSubtitles() marks its
    // siblings stale for the same reason; this path did not, so a regenerated
    // video kept showing translations that looked current and were not.
    if (language === "en") {
      await db
        .update(videoSubtitles)
        .set({ stale: true, updatedAt: new Date() })
        .where(
          and(
            eq(videoSubtitles.videoId, video.id),
            ne(videoSubtitles.language, "en"),
          ),
        );
    }

    if (video.bunnyVideoId) {
      await addCaption(video.bunnyVideoId, language, label ?? language, vtt);
      await db
        .update(videoSubtitles)
        .set({ bunnyUploadedAt: new Date() })
        .where(
          and(
            eq(videoSubtitles.videoId, video.id),
            eq(videoSubtitles.language, language),
          ),
        );
    }

    // Touch the parent event and bump the events sync version so the app's
    // version-gated sync + no-TTL cache pick up the newly available subtitles.
    await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, event.id));
    bumpVersion("events").catch((e) => console.error("[webhook] bumpVersion failed:", e));
  }

  return c.json({ ok: true });
});

/**
 * POST /api/webhooks/video-burn
 *
 * Called by the AWS Batch container when a title-slide burn-in job
 * finishes (or fails). Validates HMAC-SHA256 signature (same scheme as
 * /read-along and /subtitles above), then updates the EXISTING
 * event_videos row in place — never inserts a new row, since
 * video_progress and bookmarks key on event_videos.id and must survive
 * the swap to a re-burned Bunny video.
 *
 * Re-burn semantics: when this video already had a successful burn
 * (burnedIntroMs was non-null) and the new intro length differs, every
 * video_progress row for this video was timed against the OLD merged
 * timeline and is now off by the delta, and every video_subtitles row's
 * cues (also absolute-timed from the start of the merged video) can no
 * longer be trusted. Both are corrected/flagged in the SAME transaction as
 * the event_videos update, so a crash mid-way can never leave the row
 * pointing at a new Bunny video while progress/subtitles still reflect the
 * old timeline. See computeIntroDelta / applyIntroDeltaInTransaction in
 * services/video-burn.ts. On a FIRST burn (burnedIntroMs was null) neither
 * applies — there is nothing yet to desync.
 *
 * No auth middleware — public endpoint, HMAC-authenticated.
 */
webhookRoutes.post("/video-burn", async (c) => {
  const signature = c.req.header("X-Webhook-Signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const rawBody = await c.req.text();
  const expected = createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const { jobId, videoId, status, bunnyVideoId, introMs, warning, error, masterS3Key } =
    JSON.parse(rawBody);

  if (!jobId || !videoId || !status) {
    return c.json({ error: "Missing jobId, videoId, or status" }, 400);
  }

  console.log(`[webhook] Video burn ${status} for video ${videoId} (job ${jobId})`);

  if (status === "completed" && bunnyVideoId) {
    const video = await db.query.eventVideos.findFirst({
      where: eq(eventVideos.id, videoId),
    });
    if (!video) {
      console.warn(`[webhook] Video burn job ${jobId} references missing event_video ${videoId}`);
      return c.json({ ok: true });
    }

    const newIntroMs = typeof introMs === "number" ? introMs : 0;
    const { deltaMs } = computeIntroDelta(video.burnedIntroMs, newIntroMs);

    await db.transaction(async (tx) => {
      await tx
        .update(eventVideos)
        .set({
          bunnyVideoId,
          burnStatus: "done",
          burnedIntroMs: newIntroMs,
          burnError: null,
          updatedAt: new Date(),
          // Present on a URL-imported burn (see MASTER_SOURCE_URL in
          // containers/video-burn/source.ts) — the container retains the
          // untouched original in S3 before burning and reports its key
          // back here so re-burns have a first-generation master, exactly
          // like the S3-upload path already did from the start.
          ...(typeof masterS3Key === "string" ? { masterS3Key } : {}),
        })
        .where(eq(eventVideos.id, videoId));

      await applyIntroDeltaInTransaction(tx, videoId, deltaMs);
    });

    if (warning) {
      // The merged video itself is fine (e.g. thumbnail extraction failed);
      // surfaced for the admin to notice and re-trigger if they care.
      console.warn(`[webhook] Video burn job ${jobId} completed with a warning: ${warning}`);
    }

    // Touch the parent event and bump the events sync version so the app's
    // version-gated sync + no-TTL cache pick up the newly available video.
    await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, video.eventId));
    bumpVersion("events").catch((e) => console.error("[webhook] bumpVersion failed:", e));
  } else {
    await db
      .update(eventVideos)
      .set({
        burnStatus: "failed",
        burnError: error ?? "Video burn job failed",
        updatedAt: new Date(),
      })
      .where(eq(eventVideos.id, videoId));
  }

  return c.json({ ok: true });
});

export { webhookRoutes };
