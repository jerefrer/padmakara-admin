import { Hono } from "hono";
import { eq, and, or, like, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  events,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
} from "../../db/schema/retreats.ts";
import { eventPublications } from "../../db/schema/publications.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { eventVideos } from "../../db/schema/event-videos.ts";
import { sessions } from "../../db/schema/sessions.ts";
import { tracks } from "../../db/schema/tracks.ts";
import { transcripts } from "../../db/schema/transcripts.ts";
import { eventFiles } from "../../db/schema/event-files.ts";
import { createEventSchema, updateEventSchema, aiAssistSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { submitReadAlongJob, getReadAlongJobs } from "../../services/read-along.ts";
import { bumpVersion } from "../../services/sync-versions.ts";
import { aiAssistEvent } from "../../services/ai-assist.ts";

const eventRoutes = new Hono();

const columns: Record<string, any> = {
  id: events.id,
  eventCode: events.eventCode,
  titleEn: events.titleEn,
  startDate: events.startDate,
  endDate: events.endDate,
  status: events.status,
  eventTypeId: events.eventTypeId,
  featuredAt: events.featuredAt,
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

  // Event type filter — supports the "none" sentinel for events with no type set.
  if (eventTypeId === "none") {
    conditions.push(isNull(events.eventTypeId));
  } else if (eventTypeId) {
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
      eventPublications: { with: { publication: true } },
    },
  });

  // Apply array filters in memory
  let filteredData = allData;

  if (teacherIds) {
    const parts = teacherIds.split(",");
    const includeEmpty = parts.includes("none");
    const ids = parts.filter((p) => p !== "none").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      event.eventTeachers.some((et) => ids.includes(et.teacherId)) ||
      (includeEmpty && event.eventTeachers.length === 0)
    );
  }

  if (groupIds) {
    const parts = groupIds.split(",");
    const includeEmpty = parts.includes("none");
    const ids = parts.filter((p) => p !== "none").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      event.eventRetreatGroups.some((eg) => ids.includes(eg.retreatGroupId)) ||
      (includeEmpty && event.eventRetreatGroups.length === 0)
    );
  }

  if (audienceIds) {
    const parts = audienceIds.split(",");
    const includeNull = parts.includes("none");
    const ids = parts.filter((p) => p !== "none").map((id) => parseInt(id, 10));
    filteredData = filteredData.filter((event) =>
      (event.audienceId !== null && ids.includes(event.audienceId)) ||
      (includeNull && event.audienceId == null)
    );
  }

  // Apply pagination to filtered results
  const total = filteredData.length;
  const paginatedData = filteredData.slice(offset, offset + limit);

  // Content-presence flags for the list icons (cheap grouped existence scans).
  const ids = paginatedData.map((e: { id: number }) => e.id);
  const hasVideo = new Set<number>();
  const hasAudio = new Set<number>();
  const hasDocs = new Set<number>();
  if (ids.length) {
    const [vids, auds, trs, files] = await Promise.all([
      db.select({ id: eventVideos.eventId }).from(eventVideos)
        .where(inArray(eventVideos.eventId, ids)).groupBy(eventVideos.eventId),
      db.select({ id: sessions.eventId }).from(tracks)
        .innerJoin(sessions, eq(tracks.sessionId, sessions.id))
        .where(inArray(sessions.eventId, ids)).groupBy(sessions.eventId),
      db.select({ id: transcripts.eventId }).from(transcripts)
        .where(inArray(transcripts.eventId, ids)).groupBy(transcripts.eventId),
      db.select({ id: eventFiles.eventId }).from(eventFiles)
        .where(and(
          inArray(eventFiles.eventId, ids),
          inArray(eventFiles.fileType, ["document", "image", "other"]),
        )).groupBy(eventFiles.eventId),
    ]);
    vids.forEach((r) => hasVideo.add(r.id));
    auds.forEach((r) => hasAudio.add(r.id));
    trs.forEach((r) => hasDocs.add(r.id));
    files.forEach((r) => hasDocs.add(r.id));
  }
  const enriched = paginatedData.map((e: { id: number }) => ({
    ...e,
    hasVideo: hasVideo.has(e.id),
    hasAudio: hasAudio.has(e.id),
    hasDocuments: hasDocs.has(e.id),
  }));

  return listResponse(c, enriched, total, offset, offset + limit, "events");
});

eventRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      sessions: {
        with: {
          tracks: true,
        },
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
      },
      videos: { orderBy: (v: any, { asc }: any) => [asc(v.position)] },
      transcripts: true,
      eventFiles: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
      eventPublications: { with: { publication: true } },
    },
  });

  if (!event) throw AppError.notFound("Event not found");
  return c.json({
    ...event,
    publicationIds: event.eventPublications?.map((ep: any) => ep.publicationId) || [],
  });
});

eventRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, publicationIds, featuredAt, ...eventData } =
    createEventSchema.parse(body);

  const [event] = await db.insert(events).values({
    ...eventData,
    featuredAt: featuredAt ? new Date(featuredAt) : null,
  }).returning();

  // Insert junction records
  await syncJunctions(event!.id, teacherIds, groupIds, placeIds);

  // Sync publications
  if (publicationIds && publicationIds.length > 0) {
    await db.insert(eventPublications).values(
      publicationIds.map((pubId: number) => ({
        eventId: event!.id,
        publicationId: pubId,
      })),
    );
  }

  // Return full event with relations
  const full = await db.query.events.findFirst({
    where: eq(events.id, event!.id),
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
      eventPublications: { with: { publication: true } },
    },
  });

  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(full!, 201);
});

eventRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const { teacherIds, groupIds, placeIds, publicationIds, featuredAt, ...eventData } =
    updateEventSchema.parse(body);

  // Only include fields that were actually sent in the request body,
  // so Zod defaults (e.g. status: "draft") don't overwrite existing values.
  const bodyKeys = new Set(Object.keys(body));
  const filteredEventData: Record<string, any> = {};
  for (const [key, value] of Object.entries(eventData)) {
    if (bodyKeys.has(key)) {
      filteredEventData[key] = value;
    }
  }

  const [event] = await db
    .update(events)
    .set({
      ...filteredEventData,
      ...(bodyKeys.has("featuredAt") ? { featuredAt: featuredAt ? new Date(featuredAt) : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(events.id, id))
    .returning();

  if (!event) throw AppError.notFound("Event not found");

  // Sync junction tables only if actually sent in request
  if (bodyKeys.has("teacherIds") || bodyKeys.has("groupIds") || bodyKeys.has("placeIds")) {
    await syncJunctions(
      id,
      bodyKeys.has("teacherIds") ? teacherIds : undefined,
      bodyKeys.has("groupIds") ? groupIds : undefined,
      bodyKeys.has("placeIds") ? placeIds : undefined,
    );
  }

  // Sync publications only if actually sent
  if (bodyKeys.has("publicationIds")) {
    await db.delete(eventPublications).where(eq(eventPublications.eventId, id));
    if (publicationIds && publicationIds.length > 0) {
      await db.insert(eventPublications).values(
        publicationIds.map((pubId: number) => ({
          eventId: id,
          publicationId: pubId,
        })),
      );
    }
  }

  const full = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
      eventPublications: { with: { publication: true } },
    },
  });

  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(full!);
});

eventRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [event] = await db
    .delete(events)
    .where(eq(events.id, id))
    .returning();
  if (!event) throw AppError.notFound("Event not found");
  bumpVersion("events").catch((err) =>
    console.error("[sync] failed to bump events version:", err),
  );
  return c.json(event);
});

// ── AI Track Rename ───────────────────────────────────────────────────

/**
 * POST /admin/events/:id/rename-tracks
 *
 * Apply a natural-language instruction to a list of parsed track rows and
 * return suggested edits. The AI never mutates S3 or the database; the
 * caller applies the suggestions to the editable rename-preview table and
 * can review before committing.
 *
 * Body: { instruction: string, event?, sessions?, tracks: { rowKey, originalFilename, title, titleEn?, titlePt?, speaker }[] }
 * Response: { event?, sessions: { rowKey, titleEn?, titlePt? }[], tracks: { rowKey, titleEn?, titlePt?, speaker?, speakerUnmatched? }[] }
 */
eventRoutes.post("/:id/rename-tracks", async (c) => {
  const parsed = aiAssistSchema.safeParse(await c.req.json().catch(() => null));
  // Same as the create-flow variant in upload.ts: surface Zod's issues so a
  // rejected field is identifiable instead of an opaque VALIDATION_ERROR.
  if (!parsed.success) throw parsed.error;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const roster = await db.query.teachers.findMany({
    columns: { abbreviation: true, name: true },
  });
  const result = await aiAssistEvent({ ...parsed.data, roster, apiKey });
  return c.json(result);
});

// ── Read Along ────────────────────────────────────────────────────────

/**
 * POST /admin/events/:id/read-along
 *
 * Trigger read-along alignment processing for an event.
 * Submits an AWS Batch job that runs Whisper + PDF alignment.
 */
eventRoutes.post("/:id/read-along", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json().catch(() => ({}));

  const result = await submitReadAlongJob(id, {
    language: body.language,
    skipPages: body.skipPages,
    whisperModel: body.whisperModel,
  });

  return c.json(result, 202);
});

/**
 * GET /admin/events/:id/read-along
 *
 * Get recent read-along jobs for an event.
 */
eventRoutes.get("/:id/read-along", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const jobs = await getReadAlongJobs(id);
  return c.json({ jobs });
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
