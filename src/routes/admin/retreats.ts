import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  retreats,
  retreatTeachers,
  retreatGroupRetreats,
  retreatPlaces,
} from "../../db/schema/retreats.ts";
import { createRetreatSchema, updateRetreatSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const retreatRoutes = new Hono();

const columns: Record<string, any> = {
  id: retreats.id,
  eventCode: retreats.eventCode,
  titleEn: retreats.titleEn,
  startDate: retreats.startDate,
  endDate: retreats.endDate,
  status: retreats.status,
  designation: retreats.designation,
  createdAt: retreats.createdAt,
};

retreatRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.query.retreats.findMany({
      orderBy: orderBy ? [orderBy] : undefined,
      limit,
      offset,
      with: {
        retreatTeachers: { with: { teacher: true } },
        retreatGroups: { with: { retreatGroup: true } },
        retreatPlaces: { with: { place: true } },
      },
    }),
    countRows(retreats),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "retreats");
});

retreatRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const retreat = await db.query.retreats.findFirst({
    where: eq(retreats.id, id),
    with: {
      sessions: {
        with: { tracks: true },
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
      },
      retreatTeachers: { with: { teacher: true } },
      retreatGroups: { with: { retreatGroup: true } },
      retreatPlaces: { with: { place: true } },
    },
  });

  if (!retreat) throw AppError.notFound("Retreat not found");
  return c.json(retreat);
});

retreatRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, ...retreatData } =
    createRetreatSchema.parse(body);

  const [retreat] = await db.insert(retreats).values(retreatData).returning();

  // Insert junction records
  await syncJunctions(retreat!.id, teacherIds, groupIds, placeIds);

  // Return full retreat with relations
  const full = await db.query.retreats.findFirst({
    where: eq(retreats.id, retreat!.id),
    with: {
      retreatTeachers: { with: { teacher: true } },
      retreatGroups: { with: { retreatGroup: true } },
      retreatPlaces: { with: { place: true } },
    },
  });

  return c.json(full!, 201);
});

retreatRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, ...retreatData } =
    updateRetreatSchema.parse(body);

  const [retreat] = await db
    .update(retreats)
    .set({ ...retreatData, updatedAt: new Date() })
    .where(eq(retreats.id, id))
    .returning();

  if (!retreat) throw AppError.notFound("Retreat not found");

  // Sync junction tables if provided
  if (teacherIds !== undefined || groupIds !== undefined || placeIds !== undefined) {
    await syncJunctions(id, teacherIds, groupIds, placeIds);
  }

  const full = await db.query.retreats.findFirst({
    where: eq(retreats.id, id),
    with: {
      retreatTeachers: { with: { teacher: true } },
      retreatGroups: { with: { retreatGroup: true } },
      retreatPlaces: { with: { place: true } },
    },
  });

  return c.json(full!);
});

retreatRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [retreat] = await db
    .delete(retreats)
    .where(eq(retreats.id, id))
    .returning();
  if (!retreat) throw AppError.notFound("Retreat not found");
  return c.json(retreat);
});

/**
 * Sync junction tables for a retreat. Deletes existing and re-inserts.
 */
async function syncJunctions(
  retreatId: number,
  teacherIds?: { id: number; role: string }[],
  groupIds?: number[],
  placeIds?: number[],
) {
  if (teacherIds !== undefined) {
    await db.delete(retreatTeachers).where(eq(retreatTeachers.retreatId, retreatId));
    if (teacherIds.length > 0) {
      await db.insert(retreatTeachers).values(
        teacherIds.map((t) => ({
          retreatId,
          teacherId: t.id,
          role: t.role,
        })),
      );
    }
  }

  if (groupIds !== undefined) {
    await db.delete(retreatGroupRetreats).where(eq(retreatGroupRetreats.retreatId, retreatId));
    if (groupIds.length > 0) {
      await db.insert(retreatGroupRetreats).values(
        groupIds.map((retreatGroupId) => ({ retreatId, retreatGroupId })),
      );
    }
  }

  if (placeIds !== undefined) {
    await db.delete(retreatPlaces).where(eq(retreatPlaces.retreatId, retreatId));
    if (placeIds.length > 0) {
      await db.insert(retreatPlaces).values(
        placeIds.map((placeId) => ({ retreatId, placeId })),
      );
    }
  }
}

export { retreatRoutes };
