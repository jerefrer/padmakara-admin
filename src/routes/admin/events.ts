import { Hono } from "hono";
import { eq, and, or, like, ilike, inArray, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../../db/index.ts";
import {
  events,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
  eventAudiences,
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

  // Parse filters from query params
  const q = c.req.query("q"); // Search query
  const status = c.req.query("status");
  const eventTypeId = c.req.query("eventTypeId");
  const teacherIds = c.req.query("teacherIds");
  const groupIds = c.req.query("groupIds");
  const audienceIds = c.req.query("audienceIds");

  // Build WHERE conditions
  const conditions: any[] = [];

  // Text search across event code and titles (case-insensitive)
  if (q) {
    conditions.push(
      or(
        ilike(events.eventCode, `%${q}%`),
        ilike(events.titleEn, `%${q}%`),
        ilike(events.titlePt, `%${q}%`)
      )
    );
  }

  // Status filter
  if (status) {
    conditions.push(eq(events.status, status));
  }

  // Event type filter
  if (eventTypeId) {
    conditions.push(eq(events.eventTypeId, parseInt(eventTypeId, 10)));
  }

  // For array filters (teachers, groups, audiences), we need to filter after fetching
  // because they're in junction tables and Drizzle query API doesn't support complex joins easily
  const allData = await db.query.events.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: orderBy ? [orderBy] : undefined,
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  // Apply array filters in memory
  let filteredData = allData;

  if (teacherIds) {
    const ids = teacherIds.split(",").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      event.eventTeachers.some((et) => ids.includes(et.teacherId))
    );
  }

  if (groupIds) {
    const ids = groupIds.split(",").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      event.eventRetreatGroups.some((eg) => ids.includes(eg.retreatGroupId))
    );
  }

  if (audienceIds) {
    const ids = audienceIds.split(",").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      ids.includes(event.audienceId)
    );
  }

  // Apply pagination to filtered results
  const total = filteredData.length;
  const paginatedData = filteredData.slice(offset, offset + limit);

  return listResponse(c, paginatedData, total, offset, offset + limit, "events");
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
      transcripts: true,
      eventFiles: true,
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
 * POST /admin/events/:id/translate-themes
 *
 * Translate main themes and/or session themes between EN and PT
 * using the Anthropic API. Body: { direction: "en-to-pt" | "pt-to-en", fields?: ["mainThemes", "sessionThemes"] }
 */
eventRoutes.post("/:id/translate-themes", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const direction: string = body.direction || "en-to-pt";
  const fields: string[] = body.fields || ["mainThemes", "sessionThemes"];

  if (!["en-to-pt", "pt-to-en"].includes(direction)) {
    throw AppError.badRequest("direction must be 'en-to-pt' or 'pt-to-en'");
  }

  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
  });
  if (!event) throw AppError.notFound("Event not found");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw AppError.internal("ANTHROPIC_API_KEY not configured");
  }

  const anthropic = new Anthropic({ apiKey });
  const fromLang = direction === "en-to-pt" ? "English" : "Portuguese";
  const toLang = direction === "en-to-pt" ? "Portuguese" : "English";

  // Collect source texts
  const toTranslate: { field: string; source: string }[] = [];

  if (fields.includes("mainThemes")) {
    const source = direction === "en-to-pt" ? event.mainThemesEn : event.mainThemesPt;
    if (source) {
      toTranslate.push({ field: "mainThemes", source });
    }
  }
  if (fields.includes("sessionThemes")) {
    const source = direction === "en-to-pt" ? event.sessionThemesEn : event.sessionThemesPt;
    if (source) {
      toTranslate.push({ field: "sessionThemes", source });
    }
  }

  if (toTranslate.length === 0) {
    throw AppError.badRequest("No source text found for the requested fields and direction");
  }

  // Build prompt
  const prompt = toTranslate
    .map((item) => `### ${item.field}\n${item.source}`)
    .join("\n\n");

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `You are translating Buddhist teaching materials from ${fromLang} to ${toLang} (European ${toLang}). Preserve Buddhist terminology (dharma names, Sanskrit/Tibetan terms). Maintain structure and formatting. Respond with a JSON object where keys are the field names and values are the translated text. Example: {"mainThemes": "...", "sessionThemes": "..."}`,
    messages: [
      {
        role: "user",
        content: `Translate the following fields from ${fromLang} to ${toLang}:\n\n${prompt}`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from translation API");
  }

  let responseText = textBlock.text.trim();
  // Strip markdown code fences if present
  if (responseText.startsWith("```")) {
    responseText = responseText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  let translations: Record<string, string>;
  try {
    translations = JSON.parse(responseText);
  } catch {
    throw AppError.internal("Failed to parse translation response");
  }

  // Update the DB
  const updates: Record<string, string> = {};
  if (translations.mainThemes) {
    if (direction === "en-to-pt") {
      updates.mainThemesPt = translations.mainThemes;
    } else {
      updates.mainThemesEn = translations.mainThemes;
    }
  }
  if (translations.sessionThemes) {
    if (direction === "en-to-pt") {
      updates.sessionThemesPt = translations.sessionThemes;
    } else {
      updates.sessionThemesEn = translations.sessionThemes;
    }
  }

  if (Object.keys(updates).length > 0) {
    await db
      .update(events)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(events.id, id));
  }

  // Return updated event
  const updated = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  return c.json({
    translated: Object.keys(updates),
    event: updated,
  });
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
