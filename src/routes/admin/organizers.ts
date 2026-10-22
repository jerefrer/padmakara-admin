import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { organizers } from "../../db/schema/organizers.ts";
import { createOrganizerSchema, updateOrganizerSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const organizerRoutes = new Hono();

const columns: Record<string, any> = {
  id: organizers.id,
  name: organizers.name,
  abbreviation: organizers.abbreviation,
  createdAt: organizers.createdAt,
};

organizerRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.select().from(organizers).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(organizers),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "organizers");
});

organizerRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const organizer = await db.query.organizers.findFirst({
    where: eq(organizers.id, id),
  });
  if (!organizer) throw AppError.notFound("Organizer not found");
  return c.json(organizer);
});

organizerRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createOrganizerSchema.parse(body);
  const [organizer] = await db.insert(organizers).values(data).returning();
  return c.json(organizer!, 201);
});

organizerRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateOrganizerSchema.parse(body);
  const [organizer] = await db
    .update(organizers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(organizers.id, id))
    .returning();
  if (!organizer) throw AppError.notFound("Organizer not found");
  return c.json(organizer);
});

organizerRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [organizer] = await db
    .delete(organizers)
    .where(eq(organizers.id, id))
    .returning();
  if (!organizer) throw AppError.notFound("Organizer not found");
  return c.json(organizer);
});

export { organizerRoutes };
