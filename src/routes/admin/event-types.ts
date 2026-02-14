import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { eventTypes } from "../../db/schema/event-types.ts";
import { createEventTypeSchema, updateEventTypeSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const eventTypeRoutes = new Hono();

const columns: Record<string, any> = {
  id: eventTypes.id,
  nameEn: eventTypes.nameEn,
  namePt: eventTypes.namePt,
  abbreviation: eventTypes.abbreviation,
  slug: eventTypes.slug,
  displayOrder: eventTypes.displayOrder,
  createdAt: eventTypes.createdAt,
};

eventTypeRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.select().from(eventTypes).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(eventTypes),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "event-types");
});

eventTypeRoutes.put("/reorder", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(eventTypes)
      .set({ displayOrder: i, updatedAt: new Date() })
      .where(eq(eventTypes.id, ids[i]!));
  }
  return c.json({ success: true });
});

eventTypeRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const row = await db.query.eventTypes.findFirst({
    where: eq(eventTypes.id, id),
  });
  if (!row) throw AppError.notFound("Event type not found");
  return c.json(row);
});

eventTypeRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createEventTypeSchema.parse(body);
  const [row] = await db.insert(eventTypes).values(data).returning();
  return c.json(row!, 201);
});

eventTypeRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateEventTypeSchema.parse(body);
  const [row] = await db
    .update(eventTypes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(eventTypes.id, id))
    .returning();
  if (!row) throw AppError.notFound("Event type not found");
  return c.json(row);
});

eventTypeRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [row] = await db
    .delete(eventTypes)
    .where(eq(eventTypes.id, id))
    .returning();
  if (!row) throw AppError.notFound("Event type not found");
  return c.json(row);
});

export { eventTypeRoutes };
