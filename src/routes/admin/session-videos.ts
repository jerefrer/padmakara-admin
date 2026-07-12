import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessionVideos } from "../../db/schema/session-videos.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { events } from "../../db/schema/retreats.ts";
import { createSessionVideoSchema, updateSessionVideoSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, listResponse, countRows } from "./helpers.ts";
import { deleteVideo } from "../../services/bunny.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

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

export { sessionVideoRoutes };
