import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { createSessionSchema, updateSessionSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { deleteVideo } from "../../services/bunny.ts";

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
      with: { tracks: true },
    }),
    countRows(sessions, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "sessions");
});

sessionRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, id),
    with: { tracks: true },
  });
  if (!session) throw AppError.notFound("Session not found");
  return c.json(session);
});

sessionRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createSessionSchema.parse(body);
  const [session] = await db.insert(sessions).values(data).returning();
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
  return c.json(session);
});

sessionRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [session] = await db
    .delete(sessions)
    .where(eq(sessions.id, id))
    .returning();
  if (!session) throw AppError.notFound("Session not found");

  // Reference-counted cleanup: only delete the Bunny video if no other session
  // still points at the same GUID. Migration may share one video across
  // multiple events when the source file is identical (e.g. mandala demos
  // referenced from three different retreat events).
  if (session.bunnyVideoId) {
    const stillReferenced = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.bunnyVideoId, session.bunnyVideoId),
        ne(sessions.id, session.id),
      ),
    });
    if (!stillReferenced) {
      deleteVideo(session.bunnyVideoId).catch((err) => {
        console.error(`Failed to delete Bunny video ${session.bunnyVideoId}:`, err);
      });
    } else {
      console.log(
        `[sessions] Keeping Bunny video ${session.bunnyVideoId} — still referenced by session ${stillReferenced.id}`,
      );
    }
  }

  return c.json(session);
});

export { sessionRoutes };
