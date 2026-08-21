/**
 * Assembles the metadata the default slide templates (src/lib/slides/defaults.ts)
 * are generated from, for one event. Shared by two admin routes:
 *
 *  - POST /admin/videos/:id/slides/defaults — an existing event_video row.
 *    Prefers the video's own `videoDate` over the event's start date.
 *  - POST /admin/events/:id/slides/defaults — no video row yet (drafting
 *    slides before the file is even picked). Falls back to the event's
 *    `startDate` since there is no video date to prefer.
 *
 * The two differ only in what they pass as `dateOverride` — everything else
 * (teachers, event type, place, organizer, credits) comes from the same
 * event row. Factored out so the two routes can't quietly drift apart.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import type { SlideTemplateMetadata } from "../lib/slides/defaults.ts";

/**
 * Fetch the event (with the relations the templates need) and assemble its
 * `SlideTemplateMetadata`. Returns null when the event doesn't exist, so
 * callers can 404 without a separate existence check.
 */
export async function fetchSlideTemplateMetadata(
  eventId: number,
  dateOverride?: string | null,
): Promise<SlideTemplateMetadata | null> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: {
      eventType: true,
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
    },
  });
  if (!event) return null;

  const place = event.eventPlaces[0]?.place;

  return {
    teacherNames: event.eventTeachers.map((et) => et.teacher.name),
    eventTypeEn: event.eventType?.nameEn ?? null,
    eventTypePt: event.eventType?.namePt ?? null,
    date: dateOverride ?? event.startDate ?? null,
    organizer: event.organizer ?? null,
    placeName: place?.name ?? null,
    placeLocation: place?.location ?? null,
    creditLines: event.creditLines ?? [],
    copyrightHolder: event.copyrightHolder ?? null,
    // The outro logo key isn't configured yet — buildDefaultOutro returns []
    // when it's null, which is the correct "no outro slide" behaviour.
    logoS3Key: null,
  };
}
