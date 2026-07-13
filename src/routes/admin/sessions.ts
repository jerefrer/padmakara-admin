import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { events } from "../../db/schema/retreats.ts";
import { createSessionSchema, updateSessionSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

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

// Subtitle management moved to /admin/session-videos/:videoId/subtitles* —
// subtitles are now generated and stored per session_video, not per session.
// See src/routes/admin/session-videos.ts.

export { sessionRoutes };
