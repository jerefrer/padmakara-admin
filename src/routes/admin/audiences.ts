import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { audiences } from "../../db/schema/audiences.ts";
import { createAudienceSchema, updateAudienceSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const audienceRoutes = new Hono();

const columns: Record<string, any> = {
  id: audiences.id,
  nameEn: audiences.nameEn,
  namePt: audiences.namePt,
  slug: audiences.slug,
  displayOrder: audiences.displayOrder,
  createdAt: audiences.createdAt,
};

audienceRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(audiences.nameEn, `%${q}%`),
        ilike(audiences.namePt, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(audiences).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(audiences, where),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "audiences");
});

audienceRoutes.put("/reorder", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(audiences)
      .set({ displayOrder: i, updatedAt: new Date() })
      .where(eq(audiences.id, ids[i]!));
  }
  return c.json({ success: true });
});

audienceRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const row = await db.query.audiences.findFirst({
    where: eq(audiences.id, id),
  });
  if (!row) throw AppError.notFound("Audience not found");
  return c.json(row);
});

audienceRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createAudienceSchema.parse(body);
  const [row] = await db.insert(audiences).values(data).returning();
  return c.json(row!, 201);
});

audienceRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateAudienceSchema.parse(body);
  const [row] = await db
    .update(audiences)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(audiences.id, id))
    .returning();
  if (!row) throw AppError.notFound("Audience not found");
  return c.json(row);
});

audienceRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [row] = await db
    .delete(audiences)
    .where(eq(audiences.id, id))
    .returning();
  if (!row) throw AppError.notFound("Audience not found");
  return c.json(row);
});

export { audienceRoutes };
