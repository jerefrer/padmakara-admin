import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { tracks } from "../../db/schema/tracks.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { events } from "../../db/schema/retreats.ts";
import { createTrackSchema, updateTrackSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { deleteObject, generatePresignedAttachmentUrl } from "../../services/s3.ts";
import { buildConventionFilename } from "../../services/track-filename.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

const trackRoutes = new Hono();

const columns: Record<string, any> = {
  id: tracks.id,
  sessionId: tracks.sessionId,
  title: tracks.title,
  trackNumber: tracks.trackNumber,
  originalLanguage: tracks.originalLanguage,
  createdAt: tracks.createdAt,
};

trackRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  // Optional filter by session
  const sessionId = c.req.query("sessionId");
  const where = sessionId
    ? eq(tracks.sessionId, parseInt(sessionId, 10))
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(tracks).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(tracks, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "tracks");
});

trackRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, id),
  });
  if (!track) throw AppError.notFound("Track not found");
  return c.json(track);
});

trackRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createTrackSchema.parse(body);
  const [track] = await db.insert(tracks).values(data).returning();
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, track!.sessionId),
  });
  if (session) {
    await db
      .update(events)
      .set({ updatedAt: new Date() })
      .where(eq(events.id, session.eventId));
  }
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(track!, 201);
});

trackRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const parsed = updateTrackSchema.parse(body);
  // Strip undefined values so we only update fields that were actually sent
  const data: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(parsed)) {
    if (val !== undefined) data[key] = val;
  }
  const [track] = await db
    .update(tracks)
    .set(data)
    .where(eq(tracks.id, id))
    .returning();
  if (!track) throw AppError.notFound("Track not found");
  const trackSession = await db.query.sessions.findFirst({
    where: eq(sessions.id, track.sessionId),
  });
  if (trackSession) {
    await db
      .update(events)
      .set({ updatedAt: new Date() })
      .where(eq(events.id, trackSession.eventId));
  }
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(track);
});

/**
 * GET /:id/download-url — Returns a short-lived presigned S3 URL that
 * forces the browser to download the audio file (Content-Disposition:
 * attachment) so admins can grab a track without going through the AWS
 * console. The filename follows the import naming convention
 * (docs/NAMING-CONVENTIONS.md), rebuilt from current metadata, so a
 * downloaded track can be re-imported as-is.
 */
trackRoutes.get("/:id/download-url", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const track = await db.query.tracks.findFirst({ where: eq(tracks.id, id) });
  if (!track) throw AppError.notFound("Track not found");
  if (!track.s3Key) throw AppError.badRequest("Track has no audio file", "NO_S3_KEY");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, track.sessionId),
  });
  const filename = buildConventionFilename(
    {
      trackNumber: track.trackNumber,
      title: track.title || `track-${track.id}`,
      speaker: track.speaker,
      languages: track.languages,
      isTranslation: track.isTranslation,
      s3Key: track.s3Key,
    },
    {
      sessionDate: session?.sessionDate ?? null,
      timePeriod: session?.timePeriod ?? null,
      partNumber: session?.partNumber ?? null,
    },
  );

  const url = await generatePresignedAttachmentUrl(track.s3Key, filename, 600);
  return c.json({ url, filename, expiresIn: 600 });
});

/**
 * DELETE /:id — Remove a track and its associated S3 objects.
 *
 * Deletes the audio file (`s3Key`) and any read-along JSON
 * (`readAlongS3Key`) before dropping the row. S3 deletes are
 * best-effort: a missing or already-deleted object should not block the
 * DB delete, since the source of truth for whether the track exists is
 * the row itself.
 */
trackRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [track] = await db
    .delete(tracks)
    .where(eq(tracks.id, id))
    .returning();
  if (!track) throw AppError.notFound("Track not found");

  if (track.s3Key) {
    await deleteObject(track.s3Key).catch(() => {});
  }
  if (track.readAlongS3Key) {
    await deleteObject(track.readAlongS3Key).catch(() => {});
  }

  const deletedSession = await db.query.sessions.findFirst({
    where: eq(sessions.id, track.sessionId),
  });
  if (deletedSession) {
    await db
      .update(events)
      .set({ updatedAt: new Date() })
      .where(eq(events.id, deletedSession.eventId));
  }
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(track);
});

export { trackRoutes };
