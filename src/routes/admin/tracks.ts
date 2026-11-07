import { Hono } from "hono";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { tracks } from "../../db/schema/tracks.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { events } from "../../db/schema/retreats.ts";
import { bulkUpdateTracksSchema, createTrackSchema, updateTrackSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { deleteObject, generatePresignedAttachmentUrl } from "../../services/s3.ts";
import { buildConventionFilename } from "../../services/track-filename.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

const trackRoutes = new Hono();

const TRACK_NUMBER_CONSTRAINT = "tracks_session_id_track_number_original_language_unique";
const LANGUAGE_NAMES: Record<string, string> = { en: "English", pt: "Portuguese", tib: "Tibetan" };

/**
 * Turns the session/number/language unique violation into a message naming the
 * track in the way, e.g. when a move lands on a session that already has that
 * number in that language. Null for any other error.
 */
async function describeTrackNumberConflict(
  err: unknown,
  id: number,
  data: Record<string, unknown>,
): Promise<AppError | null> {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  // postgres.js names the constraint `constraint_name`.
  const { code, constraint_name } = (pgError ?? {}) as { code?: string; constraint_name?: string };
  if (code !== "23505" || constraint_name !== TRACK_NUMBER_CONSTRAINT) return null;

  const current = await db.query.tracks.findFirst({ where: eq(tracks.id, id) });
  if (!current) return null;
  const sessionId = (data.sessionId as number | undefined) ?? current.sessionId;
  const trackNumber = (data.trackNumber as number | undefined) ?? current.trackNumber;
  const language = (data.originalLanguage as string | undefined) ?? current.originalLanguage;
  const other = await db.query.tracks.findFirst({
    where: and(
      eq(tracks.sessionId, sessionId),
      eq(tracks.trackNumber, trackNumber),
      eq(tracks.originalLanguage, language),
      ne(tracks.id, id),
    ),
  });
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  const used = await db.query.tracks.findMany({
    columns: { trackNumber: true },
    where: and(eq(tracks.sessionId, sessionId), eq(tracks.originalLanguage, language)),
  });
  const taken = new Set(used.map((t) => t.trackNumber));
  const where = session ? `Session ${session.sessionNumber}` : "That session";
  const named = other?.title ? ` ("${other.title}")` : "";
  return new AppError(
    409,
    `${where} already has a ${LANGUAGE_NAMES[language] ?? language} track ${trackNumber}${named}. Give one of the two another number first.`,
    "TRACK_NUMBER_TAKEN",
    {
      sessionNumber: session?.sessionNumber ?? null,
      trackNumber,
      language,
      blocking: other ? { id: other.id, title: other.title } : null,
      suggestedForBlocking: freeNumberNear(trackNumber, taken, true),
      suggestedForMoved: freeNumberNear(trackNumber, taken, false),
    },
  );
}

/**
 * A free track number next to `n` in a session: just below it when `below`
 * and that number is free (the track in the way usually belongs right before),
 * otherwise the first free one above.
 */
function freeNumberNear(n: number, taken: ReadonlySet<number>, below: boolean): number {
  if (below && n > 1 && !taken.has(n - 1)) return n - 1;
  let candidate = n + 1;
  while (taken.has(candidate)) candidate++;
  return candidate;
}

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

/**
 * PATCH /bulk — apply the same metadata patch (speaker, languages,
 * isTranslation) to many tracks in one request. Mirrors PUT /:id: sets
 * `updatedAt`, touches the owning events' `updatedAt` and bumps the events
 * sync version. `originalLanguage` follows `languages[0]` like the inline editor.
 */
trackRoutes.patch("/bulk", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bulkUpdateTracksSchema.safeParse(body);
  if (!parsed.success) {
    throw AppError.badRequest(
      parsed.error.issues[0]?.message ?? "Invalid request",
      "VALIDATION_ERROR",
    );
  }
  const { patch } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];

  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.speaker !== undefined) data.speaker = patch.speaker;
  if (patch.isTranslation !== undefined) data.isTranslation = patch.isTranslation;
  if (patch.languages !== undefined) {
    data.languages = patch.languages;
    data.originalLanguage = patch.languages[0];
  }

  const updated = await db
    .update(tracks)
    .set(data)
    .where(inArray(tracks.id, ids))
    .returning({ id: tracks.id, sessionId: tracks.sessionId });

  const sessionIds = [...new Set(updated.map((t) => t.sessionId))];
  if (sessionIds.length > 0) {
    const owners = await db
      .select({ eventId: sessions.eventId })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds));
    const eventIds = [...new Set(owners.map((s) => s.eventId))];
    if (eventIds.length > 0) {
      await db
        .update(events)
        .set({ updatedAt: new Date() })
        .where(inArray(events.id, eventIds));
    }
  }
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json({ updated: updated.length, ids: updated.map((t) => t.id) });
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
  let track: typeof tracks.$inferSelect | undefined;
  try {
    [track] = await db.update(tracks).set(data).where(eq(tracks.id, id)).returning();
  } catch (err) {
    throw (await describeTrackNumberConflict(err, id, data)) ?? err;
  }
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
