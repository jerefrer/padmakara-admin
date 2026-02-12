import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { places } from "../../db/schema/places.ts";
import { createPlaceSchema, updatePlaceSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const placeRoutes = new Hono();

const columns: Record<string, any> = {
  id: places.id,
  name: places.name,
  abbreviation: places.abbreviation,
  createdAt: places.createdAt,
};

placeRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.select().from(places).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(places),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "places");
});

placeRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const place = await db.query.places.findFirst({
    where: eq(places.id, id),
  });
  if (!place) throw AppError.notFound("Place not found");
  return c.json(place);
});

placeRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createPlaceSchema.parse(body);
  const [place] = await db.insert(places).values(data).returning();
  return c.json(place!, 201);
});

placeRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updatePlaceSchema.parse(body);
  const [place] = await db
    .update(places)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(places.id, id))
    .returning();
  if (!place) throw AppError.notFound("Place not found");
  return c.json(place);
});

placeRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [place] = await db
    .delete(places)
    .where(eq(places.id, id))
    .returning();
  if (!place) throw AppError.notFound("Place not found");
  return c.json(place);
});

export { placeRoutes };
