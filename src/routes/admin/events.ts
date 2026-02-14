import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  events,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
} from "../../db/schema/retreats.ts";
import { createEventSchema, updateEventSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const eventRoutes = new Hono();

const columns: Record<string, any> = {
  id: events.id,
  eventCode: events.eventCode,
  titleEn: events.titleEn,
  startDate: events.startDate,
  endDate: events.endDate,
  status: events.status,
  eventTypeId: events.eventTypeId,
  createdAt: events.createdAt,
};

eventRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.query.events.findMany({
      orderBy: orderBy ? [orderBy] : undefined,
      limit,
      offset,
      with: {
        eventType: true,
        audience: true,
        eventTeachers: { with: { teacher: true } },
        eventRetreatGroups: { with: { retreatGroup: true } },
        eventPlaces: { with: { place: true } },
      },
    }),
    countRows(events),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "events");
});

eventRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      sessions: {
        with: { tracks: true },
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
      },
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  if (!event) throw AppError.notFound("Event not found");
  return c.json(event);
});

eventRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, ...eventData } =
    createEventSchema.parse(body);

  const [event] = await db.insert(events).values(eventData).returning();

  // Insert junction records
  await syncJunctions(event!.id, teacherIds, groupIds, placeIds);

  // Return full event with relations
  const full = await db.query.events.findFirst({
    where: eq(events.id, event!.id),
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  return c.json(full!, 201);
});

eventRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, ...eventData } =
    updateEventSchema.parse(body);

  const [event] = await db
    .update(events)
    .set({ ...eventData, updatedAt: new Date() })
    .where(eq(events.id, id))
    .returning();

  if (!event) throw AppError.notFound("Event not found");

  // Sync junction tables if provided
  if (teacherIds !== undefined || groupIds !== undefined || placeIds !== undefined) {
    await syncJunctions(id, teacherIds, groupIds, placeIds);
  }

  const full = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  return c.json(full!);
});

eventRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [event] = await db
    .delete(events)
    .where(eq(events.id, id))
    .returning();
  if (!event) throw AppError.notFound("Event not found");
  return c.json(event);
});

/**
 * Sync junction tables for an event. Deletes existing and re-inserts.
 */
async function syncJunctions(
  eventId: number,
  teacherIds?: { id: number; role: string }[],
  groupIds?: number[],
  placeIds?: number[],
) {
  if (teacherIds !== undefined) {
    await db.delete(eventTeachers).where(eq(eventTeachers.eventId, eventId));
    if (teacherIds.length > 0) {
      await db.insert(eventTeachers).values(
        teacherIds.map((t) => ({
          eventId,
          teacherId: t.id,
          role: t.role,
        })),
      );
    }
  }

  if (groupIds !== undefined) {
    await db.delete(eventRetreatGroups).where(eq(eventRetreatGroups.eventId, eventId));
    if (groupIds.length > 0) {
      await db.insert(eventRetreatGroups).values(
        groupIds.map((retreatGroupId) => ({ eventId, retreatGroupId })),
      );
    }
  }

  if (placeIds !== undefined) {
    await db.delete(eventPlaces).where(eq(eventPlaces.eventId, eventId));
    if (placeIds.length > 0) {
      await db.insert(eventPlaces).values(
        placeIds.map((placeId) => ({ eventId, placeId })),
      );
    }
  }
}

export { eventRoutes };
