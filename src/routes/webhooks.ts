import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { readAlongJobs } from "../db/schema/read-along-jobs.ts";
import { tracks } from "../db/schema/tracks.ts";
import { config } from "../config.ts";

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

  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
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
  }

  return c.json({ ok: true });
});

export { webhookRoutes };
