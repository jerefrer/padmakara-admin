import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { createRetreatGroupSchema, updateRetreatGroupSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const groupRoutes = new Hono();

const columns: Record<string, any> = {
  id: retreatGroups.id,
  nameEn: retreatGroups.nameEn,
  namePt: retreatGroups.namePt,
  slug: retreatGroups.slug,
  displayOrder: retreatGroups.displayOrder,
  createdAt: retreatGroups.createdAt,
};

groupRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.select().from(retreatGroups).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(retreatGroups),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "groups");
});

groupRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (!group) throw AppError.notFound("Group not found");
  return c.json(group);
});

groupRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createRetreatGroupSchema.parse(body);
  const [group] = await db.insert(retreatGroups).values(data).returning();
  return c.json(group!, 201);
});

groupRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateRetreatGroupSchema.parse(body);
  const [group] = await db
    .update(retreatGroups)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");
  return c.json(group);
});

groupRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [group] = await db
    .delete(retreatGroups)
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");
  return c.json(group);
});

export { groupRoutes };
