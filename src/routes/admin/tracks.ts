import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { tracks } from "../../db/schema/tracks.ts";
import { createTrackSchema, updateTrackSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

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
  return c.json(track);
});

trackRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [track] = await db
    .delete(tracks)
    .where(eq(tracks.id, id))
    .returning();
  if (!track) throw AppError.notFound("Track not found");
  return c.json(track);
});

export { trackRoutes };
