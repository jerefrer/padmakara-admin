import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { libraryRecords } from "../../db/schema/library-records.ts";
import { events } from "../../db/schema/retreats.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { places } from "../../db/schema/places.ts";
import { eventTypes } from "../../db/schema/event-types.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { audiences } from "../../db/schema/audiences.ts";
import { AppError } from "../../lib/errors.ts";
import {
  parseLibraryCsv,
  LibraryCsvError,
  searchRecords,
  suggestRecords,
  mapRecordToEvent,
  findTeacher,
  findPlace,
  placeNameFromLocation,
  abbreviationFromName,
  type SearchableRecord,
  type SuggestInput,
  type MappingRef,
} from "../../services/library-records.ts";

/**
 * Library metadata: the association's Wix "libraryEvent" CSV, uploaded here and
 * used by the admin event form to fill an event's metadata. Nothing in these
 * routes writes to an event — the form applies the values and the normal Save
 * persists them (including the link, `retreats.wix_id`).
 */
const libraryRoutes = new Hono();

const INSERT_CHUNK = 100;

/** Columns searched/matched on, plus the themes text pulled out of the raw row. */
const searchableColumns = {
  wixId: libraryRecords.wixId,
  eventCode: libraryRecords.eventCode,
  title: libraryRecords.title,
  teacherNames: libraryRecords.teacherNames,
  guestName: libraryRecords.guestName,
  organization: libraryRecords.organization,
  place: libraryRecords.place,
  designation: libraryRecords.designation,
  dateRange: libraryRecords.dateRange,
  startDate: libraryRecords.startDate,
  endDate: libraryRecords.endDate,
  themes: sql<string>`concat_ws(' ', ${libraryRecords.raw}->>'mainThemes', ${libraryRecords.raw}->>'sessionThemes')`,
};

async function loadSearchable(): Promise<SearchableRecord[]> {
  return db.select(searchableColumns).from(libraryRecords);
}

async function loadMappingRef(): Promise<MappingRef> {
  const [t, p, et, g, a] = await Promise.all([
    db.select({
      id: teachers.id, name: teachers.name, abbreviation: teachers.abbreviation, aliases: teachers.aliases,
    }).from(teachers),
    db.select({
      id: places.id, name: places.name, abbreviation: places.abbreviation, location: places.location,
    }).from(places),
    db.select({ id: eventTypes.id, nameEn: eventTypes.nameEn, namePt: eventTypes.namePt }).from(eventTypes),
    db.select({ id: retreatGroups.id, nameEn: retreatGroups.nameEn, namePt: retreatGroups.namePt }).from(retreatGroups),
    db.select({ id: audiences.id, nameEn: audiences.nameEn, namePt: audiences.namePt }).from(audiences),
  ]);
  return { teachers: t, places: p, eventTypes: et, groups: g, audiences: a };
}

/** Summary shape sent to the admin UI for a record in a list. */
function summarize(r: SearchableRecord) {
  return {
    wixId: r.wixId,
    eventCode: r.eventCode,
    title: r.title,
    teacherNames: r.teacherNames,
    guestName: r.guestName,
    organization: r.organization,
    place: r.place,
    designation: r.designation,
    dateRange: r.dateRange,
    startDate: r.startDate,
    endDate: r.endDate,
  };
}

// ── Upload ────────────────────────────────────────────────────────────

/** GET /status — how many records are loaded and when. */
libraryRoutes.get("/status", async (c) => {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      uploadedAt: sql<string | null>`max(${libraryRecords.uploadedAt})`,
    })
    .from(libraryRecords);
  return c.json({ count: row?.count ?? 0, uploadedAt: row?.uploadedAt ?? null });
});

/**
 * POST /upload — replace every library record with the rows of an uploaded
 * CSV. Accepts multipart (`file`) or the raw CSV as the request body.
 * Events keep their link (`wix_id`) even when a record disappears from the
 * new export; the response says how many linked events lost their record.
 */
libraryRoutes.post("/upload", async (c) => {
  let text: string;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw AppError.badRequest("Missing CSV file", "VALIDATION_ERROR");
    text = await file.text();
  } else {
    text = await c.req.text();
  }

  let rows;
  try {
    rows = parseLibraryCsv(text);
  } catch (err) {
    if (err instanceof LibraryCsvError) throw AppError.badRequest(err.message, "INVALID_LIBRARY_CSV");
    throw err;
  }

  const uploadedAt = new Date();
  const previous = await db.transaction(async (tx) => {
    const [before] = await tx.select({ count: sql<number>`count(*)::int` }).from(libraryRecords);
    await tx.delete(libraryRecords);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(libraryRecords).values(
        rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, uploadedAt })),
      );
    }
    return before?.count ?? 0;
  });

  const [orphans] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(sql`${events.wixId} is not null and ${events.wixId} not in (select ${libraryRecords.wixId} from ${libraryRecords})`);

  return c.json({
    imported: rows.length,
    previous,
    withDates: rows.filter((r) => r.startDate).length,
    linkedEventsWithoutRecord: orphans?.count ?? 0,
  });
});

// ── Search / suggest ──────────────────────────────────────────────────

/** GET /records?q= — ranked search over the loaded records. */
libraryRoutes.get("/records", async (c) => {
  const q = c.req.query("q") ?? "";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "25", 10) || 25, 100);
  const all = await loadSearchable();
  return c.json({ records: searchRecords(all, q, limit).map(summarize), total: all.length });
});

const suggestSchema = z.object({
  eventId: z.number().int().optional().nullable(),
  wixId: z.string().optional().nullable(),
  eventCode: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  teacherNames: z.array(z.string()).optional().default([]),
  placeName: z.string().optional().nullable(),
});

/** Merge a saved event's facts under whatever the form already holds. */
async function resolveSuggestInput(input: z.infer<typeof suggestSchema>): Promise<SuggestInput> {
  const base: SuggestInput = {
    wixId: input.wixId,
    eventCode: input.eventCode,
    title: input.title,
    startDate: input.startDate,
    endDate: input.endDate,
    teacherNames: input.teacherNames,
    placeName: input.placeName,
  };
  if (!input.eventId) return base;

  const event = await db.query.events.findFirst({
    where: eq(events.id, input.eventId),
    with: {
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
    },
  });
  if (!event) throw AppError.notFound("Event not found");
  return {
    wixId: base.wixId ?? event.wixId,
    eventCode: base.eventCode ?? event.eventCode,
    title: base.title ?? event.titlePt ?? event.titleEn,
    startDate: base.startDate ?? event.startDate,
    endDate: base.endDate ?? event.endDate,
    teacherNames: base.teacherNames?.length
      ? base.teacherNames
      : event.eventTeachers.map((et: any) => et.teacher.name),
    placeName: base.placeName ?? event.eventPlaces[0]?.place.name ?? null,
  };
}

async function suggest(input: z.infer<typeof suggestSchema>) {
  const resolved = await resolveSuggestInput(input);
  const all = await loadSearchable();
  const suggestions = suggestRecords(all, resolved);
  return {
    suggestions: suggestions.map((s) => ({ ...summarize(s.record), score: s.score, reasons: s.reasons })),
  };
}

/** GET /suggest?eventId= — best candidates for a saved event. */
libraryRoutes.get("/suggest", async (c) => {
  const eventId = parseInt(c.req.query("eventId") ?? "", 10);
  if (!Number.isInteger(eventId)) throw AppError.badRequest("eventId is required", "VALIDATION_ERROR");
  return c.json(await suggest(suggestSchema.parse({ eventId })));
});

/** POST /suggest — best candidates for an event that is still a draft in the form. */
libraryRoutes.post("/suggest", async (c) => {
  const body = suggestSchema.parse(await c.req.json());
  return c.json(await suggest(body));
});

// ── Mapping preview / entity creation ─────────────────────────────────

/** GET /records/:wixId/mapping — the event values this record would produce. */
libraryRoutes.get("/records/:wixId/mapping", async (c) => {
  const wixId = c.req.param("wixId");
  const record = await db.query.libraryRecords.findFirst({ where: eq(libraryRecords.wixId, wixId) });
  if (!record) throw AppError.notFound("Library record not found");
  const ref = await loadMappingRef();
  return c.json({ record: summarize({ ...record, themes: null }), mapping: mapRecordToEvent(record, ref) });
});

const entitiesSchema = z.object({
  teachers: z.array(z.string().min(1).max(200)).optional().default([]),
  places: z.array(z.string().min(1).max(300)).optional().default([]),
});

/**
 * POST /entities — find-or-create the teachers and places a mapping preview
 * could not resolve. The admin confirms this in the dialog before applying;
 * these rows are created immediately (they are reference data, usable by any
 * event), the event itself is only saved by the form's Save.
 */
libraryRoutes.post("/entities", async (c) => {
  const body = entitiesSchema.parse(await c.req.json());

  const existingTeachers = await db.select({
    id: teachers.id, name: teachers.name, abbreviation: teachers.abbreviation, aliases: teachers.aliases,
  }).from(teachers);
  const usedAbbreviations = new Set(existingTeachers.map((t) => t.abbreviation.toLowerCase()));

  const teacherOut: { name: string; id: number; abbreviation: string }[] = [];
  for (const name of body.teachers) {
    const found = findTeacher(name, existingTeachers);
    if (found) {
      teacherOut.push({ name, id: found.id, abbreviation: found.abbreviation });
      continue;
    }
    const base = abbreviationFromName(name);
    let abbreviation = base;
    for (let n = 2; usedAbbreviations.has(abbreviation.toLowerCase()); n++) abbreviation = `${base}${n}`;
    usedAbbreviations.add(abbreviation.toLowerCase());
    const [created] = await db
      .insert(teachers)
      .values({ name: name.trim(), abbreviation, aliases: [] })
      .returning({ id: teachers.id });
    existingTeachers.push({ id: created!.id, name: name.trim(), abbreviation, aliases: [] });
    teacherOut.push({ name, id: created!.id, abbreviation });
  }

  const existingPlaces = await db.select({
    id: places.id, name: places.name, abbreviation: places.abbreviation, location: places.location,
  }).from(places);
  const placeOut: { location: string; id: number; name: string; abbreviation: string | null }[] = [];
  for (const location of body.places) {
    const found = findPlace(location, existingPlaces);
    if (found) {
      placeOut.push({ location, id: found.id, name: found.name, abbreviation: found.abbreviation });
      continue;
    }
    const name = placeNameFromLocation(location);
    const [created] = await db
      .insert(places)
      .values({ name, location: location.trim() })
      .returning({ id: places.id });
    existingPlaces.push({ id: created!.id, name, abbreviation: null, location: location.trim() });
    placeOut.push({ location, id: created!.id, name, abbreviation: null });
  }

  return c.json({ teachers: teacherOut, places: placeOut });
});

export { libraryRoutes };
