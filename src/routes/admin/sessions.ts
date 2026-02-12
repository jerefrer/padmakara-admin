import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { createSessionSchema, updateSessionSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const sessionRoutes = new Hono();

const columns: Record<string, any> = {
  id: sessions.id,
  retreatId: sessions.retreatId,
  sessionNumber: sessions.sessionNumber,
  sessionDate: sessions.sessionDate,
  timePeriod: sessions.timePeriod,
  createdAt: sessions.createdAt,
};

sessionRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  // Optional filter by retreat
  const retreatId = c.req.query("retreatId");
  const where = retreatId
    ? eq(sessions.retreatId, parseInt(retreatId, 10))
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
  return c.json(session);
});

export { sessionRoutes };
