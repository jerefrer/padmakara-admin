import { sql } from "drizzle-orm";
import { events } from "../../db/schema/retreats.ts";
import type { SortTarget } from "./helpers.ts";

/*
 * Sort keys of the admin events list.
 *
 * The list runs through the relational query API, which rewrites every Column
 * found in an ORDER BY expression to the root table alias. Subqueries therefore
 * name their own tables as raw SQL and only reference the outer row through
 * `events.id` / `events.eventTypeId` / `events.audienceId`, which is the intended rewrite.
 * Nothing user-provided is ever interpolated: the client picks a key, not an expression.
 */

/** Alphabetically first abbreviation among the event's retreat groups (falls back to the EN name). */
const firstGroup = sql`(
  select min(coalesce(rg.abbreviation, rg.name_en))
  from retreat_group_retreats rgr
  join retreat_groups rg on rg.id = rgr.retreat_group_id
  where rgr.retreat_id = ${events.id}
)`;

/** Alphabetically first abbreviation among the event's teachers. */
const firstTeacher = sql`(
  select min(t.abbreviation)
  from retreat_teachers rt
  join teachers t on t.id = rt.teacher_id
  where rt.retreat_id = ${events.id}
)`;

const eventTypeNameEn = sql`(select et.name_en from event_types et where et.id = ${events.eventTypeId})`;
const eventTypeNamePt = sql`(select coalesce(et.name_pt, et.name_en) from event_types et where et.id = ${events.eventTypeId})`;
const audienceNameEn = sql`(select a.name_en from audiences a where a.id = ${events.audienceId})`;
const audienceNamePt = sql`(select coalesce(a.name_pt, a.name_en) from audiences a where a.id = ${events.audienceId})`;

/**
 * The list's "content" column shows up to three icons: video, audio, documents.
 * Sorting ranks events by which of them they carry, video weighing most
 * (4 video + 2 audio + 1 documents), so events with more content group together.
 * Audio counts only playable tracks (s3_key set), like the icon does.
 */
const contentRank = sql`(
  (case when exists (select 1 from event_videos ev where ev.event_id = ${events.id}) then 4 else 0 end)
  + (case when exists (
      select 1 from tracks tr join sessions se on se.id = tr.session_id
      where se.retreat_id = ${events.id} and tr.s3_key is not null
    ) then 2 else 0 end)
  + (case when exists (select 1 from transcripts tx where tx.retreat_id = ${events.id})
        or exists (
          select 1 from event_files ef
          where ef.event_id = ${events.id} and ef.file_type in ('document', 'image', 'other')
        ) then 1 else 0 end)
)`;

export const eventSortColumns: Record<string, SortTarget> = {
  id: events.id,
  eventCode: events.eventCode,
  titleEn: events.titleEn,
  // Events without a PT title are shown with the EN one, so they sort by it too.
  titlePt: sql`coalesce(${events.titlePt}, ${events.titleEn})`,
  startDate: events.startDate,
  endDate: events.endDate,
  status: events.status,
  eventTypeId: events.eventTypeId,
  eventTypeName: eventTypeNameEn,
  eventTypeNamePt,
  groups: firstGroup,
  teachers: firstTeacher,
  audienceName: audienceNameEn,
  audienceNamePt,
  content: contentRank,
  featuredAt: events.featuredAt,
  createdAt: events.createdAt,
};
