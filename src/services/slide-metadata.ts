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
 * (teachers, title, place, organizer, credits, sessions) comes from the same
 * event row. Factored out so the two routes can't quietly drift apart.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { orderedOrganizers, joinOrganizerNames, eventOrganizersWith } from "../lib/organizer-utils.ts";
import type { SlideDocument } from "../lib/slides/types.ts";
import {
  buildDefaultSlideDocument,
  isSlideLanguage,
  missingSlideInputs,
  type MissingSlideInput,
  type SlideLanguage,
  type SlideSessionInfo,
  type SlideTemplateMetadata,
} from "../lib/slides/defaults.ts";

export interface SlideMetadataResult {
  meta: SlideTemplateMetadata;
  /** The language slides default to when the caller does not choose one. */
  defaultLanguage: SlideLanguage;
}

interface SessionRow {
  id?: number;
  sessionNumber: number;
  sessionDate: string | null;
  timePeriod: string | null;
}

/**
 * Which session a video covers. Videos carry no link to a session, so the
 * only evidence is the date: the match must be unique, and an event with a
 * single session has nothing to number ("Session 1 of 1"). Returns null
 * whenever the answer would be a guess.
 */
export function matchSession(
  sessionRows: SessionRow[],
  date: string | null | undefined,
): SlideSessionInfo | null {
  if (!date || sessionRows.length < 2) return null;
  const ordered = [...sessionRows].sort((a, b) => a.sessionNumber - b.sessionNumber);
  const matches = ordered.filter((s) => s.sessionDate === date);
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match) return null;
  return {
    number: ordered.indexOf(match) + 1,
    total: ordered.length,
    date: match.sessionDate,
    period: match.timePeriod,
  };
}

/**
 * The session a video was explicitly linked to, as slide-template info.
 * Same numbering and single-session rule as matchSession; null when the id
 * is not one of the event's sessions.
 */
export function sessionInfoById(sessionRows: SessionRow[], sessionId: number): SlideSessionInfo | null {
  if (sessionRows.length < 2) return null;
  const ordered = [...sessionRows].sort((a, b) => a.sessionNumber - b.sessionNumber);
  const index = ordered.findIndex((s) => s.id === sessionId);
  const match = ordered[index];
  if (!match) return null;
  return {
    number: index + 1,
    total: ordered.length,
    date: match.sessionDate,
    period: match.timePeriod,
  };
}

/** The language slides default to: the event's original language when we have
 *  templates for it, English otherwise (e.g. Tibetan teachings). */
export function defaultSlideLanguage(originalLanguage: string | null | undefined): SlideLanguage {
  return isSlideLanguage(originalLanguage) ? originalLanguage : "en";
}

/**
 * Fetch the event (with the relations the templates need) and assemble its
 * `SlideTemplateMetadata`. Returns null when the event doesn't exist, so
 * callers can 404 without a separate existence check.
 *
 * `sessionId` is the video's own session link and wins. Without one the
 * `dateOverride` (the video's own date) is the fallback: with neither, no
 * session can be matched, because the event's start date says nothing about
 * which of its sessions a recording covers.
 */
export async function fetchSlideTemplateMetadata(
  eventId: number,
  dateOverride?: string | null,
  sessionId?: number | null,
): Promise<SlideMetadataResult | null> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: {
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
      eventOrganizers: eventOrganizersWith,
      sessions: true,
    },
  });
  if (!event) return null;

  const place = event.eventPlaces[0]?.place;
  const sessionRows = event.sessions ?? [];
  const linked = sessionId != null ? sessionInfoById(sessionRows, sessionId) : null;
  const session = linked ?? matchSession(sessionRows, dateOverride);

  return {
    defaultLanguage: defaultSlideLanguage(event.originalLanguage),
    meta: {
      teacherNames: event.eventTeachers.map((et) => et.teacher.name),
      titleEn: event.titleEn,
      titlePt: event.titlePt,
      date: dateOverride ?? linked?.date ?? event.startDate ?? null,
      session,
      organizer: joinOrganizerNames(orderedOrganizers(event.eventOrganizers)),
      placeName: place?.name ?? null,
      placeLocation: place?.location ?? null,
      creditLines: event.creditLines ?? [],
      copyrightHolder: event.copyrightHolder ?? null,
      logoS3Key: null,
    },
  };
}

export interface GeneratedSlides {
  slides: SlideDocument;
  /** Inputs the event lacks; each one dropped (part of) a slide. */
  missing: MissingSlideInput[];
  language: SlideLanguage;
}

/**
 * Generate the default slide document for a fetched event. `requested` is the
 * language the admin picked; anything that is not "en" or "pt" falls back to
 * the event's own default.
 */
export function generateDefaultSlides(
  result: SlideMetadataResult,
  requested: unknown,
): GeneratedSlides {
  const language = isSlideLanguage(requested) ? requested : result.defaultLanguage;
  return {
    slides: buildDefaultSlideDocument(result.meta, () => crypto.randomUUID(), language),
    missing: missingSlideInputs(result.meta, language),
    language,
  };
}
