/**
 * Organizers are predefined entities linked to an event through
 * `retreat_organizers` (ordered by `position`). Clients and the slide
 * templates still read one free-form string, so this module flattens the
 * relation back into it: names joined with " · " (middle dot) in position order — the app already
 * uses " | " between date, place and organizer, so neither "," nor "|" would do, or null.
 */

import { asc } from "drizzle-orm";
import { eventOrganizers } from "../db/schema/retreats.ts";

export interface OrganizerSummary {
  id: number;
  name: string;
  abbreviation: string | null;
}

interface EventOrganizerLink {
  position: number;
  organizer: OrganizerSummary | null;
}

/** Ordered organizer entities from an event's `eventOrganizers` relation. */
export function orderedOrganizers(links: EventOrganizerLink[] | undefined): OrganizerSummary[] {
  return [...(links ?? [])]
    .sort((a, b) => a.position - b.position)
    .flatMap((l) =>
      l.organizer
        ? [{ id: l.organizer.id, name: l.organizer.name, abbreviation: l.organizer.abbreviation ?? null }]
        : [],
    );
}

/** The single display string ("A · B"), or null when there are none. */
export const ORGANIZER_SEPARATOR = " \u00b7 ";

export function joinOrganizerNames(organizers: { name: string }[]): string | null {
  return organizers.length > 0 ? organizers.map((o) => o.name).join(ORGANIZER_SEPARATOR) : null;
}

/**
 * Mutate an event loaded with `eventOrganizers: { with: { organizer: true } }`:
 * replace the raw junction rows with `organizer` (joined string, the shape
 * clients always received) and `organizers` (the entities, in order).
 * Events loaded without the relation are left untouched.
 */
export function applyEventOrganizers(event: unknown): void {
  const ev = event as { eventOrganizers?: EventOrganizerLink[]; organizer?: string | null; organizers?: OrganizerSummary[] } | null;
  if (!ev || !Array.isArray(ev.eventOrganizers)) return;
  const organizers = orderedOrganizers(ev.eventOrganizers);
  ev.organizers = organizers;
  ev.organizer = joinOrganizerNames(organizers);
  delete ev.eventOrganizers;
}

export function applyEventsOrganizers(events: unknown[]): void {
  for (const event of events ?? []) applyEventOrganizers(event);
}

/** The relation fragment to add to an event `with` clause. */
export const eventOrganizersWith = {
  with: { organizer: true as const },
  orderBy: [asc(eventOrganizers.position)],
};
