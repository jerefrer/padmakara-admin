import { AppError } from "../lib/errors.ts";

/**
 * Per-section visibility of a published event.
 *
 * An event can go live with only some of its sections showing (the others are still
 * being edited): audio, video, transcripts (and read-along), texts (the event's files
 * and its related publications) and topics (the main and session themes). The flags
 * live on the event and are enforced here, server-side, for every app-facing route: a
 * hidden section is never returned and its items are a 404 when requested directly, so
 * nothing reveals they exist. Admins and superadmins always see everything, like they
 * see drafts.
 *
 * Keep the rule in this file: routes call these helpers rather than testing the flags.
 */

export interface ContentFlags {
  audioPublished?: boolean | null;
  videoPublished?: boolean | null;
  transcriptsPublished?: boolean | null;
  textsPublished?: boolean | null;
  topicsPublished?: boolean | null;
}

/** Kept for the callers that only care about the media flags. */
export type MediaFlags = ContentFlags;

export interface MediaVisibility {
  audio: boolean;
  video: boolean;
}

export interface ContentVisibility extends MediaVisibility {
  transcripts: boolean;
  texts: boolean;
  topics: boolean;
}

function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

/** What the caller may see of an event's sections. A missing flag counts as visible. */
export function contentVisibleTo(
  event: ContentFlags,
  role: string | null | undefined,
): ContentVisibility {
  if (isAdminRole(role)) {
    return { audio: true, video: true, transcripts: true, texts: true, topics: true };
  }
  return {
    audio: event.audioPublished !== false,
    video: event.videoPublished !== false,
    transcripts: event.transcriptsPublished !== false,
    texts: event.textsPublished !== false,
    topics: event.topicsPublished !== false,
  };
}

/** What the caller may see of an event's media (audio and video only). */
export function mediaVisibleTo(
  event: ContentFlags,
  role: string | null | undefined,
): MediaVisibility {
  const { audio, video } = contentVisibleTo(event, role);
  return { audio, video };
}

type Track = { readAlongS3Key?: unknown; hasReadAlong?: unknown };

/** Read-along is part of the transcripts section: a track no longer offers it when hidden. */
function clearReadAlong(track: unknown): void {
  if (!track || typeof track !== "object") return;
  const t = track as Track;
  delete t.readAlongS3Key;
  if ("hasReadAlong" in t) t.hasReadAlong = false;
}

const THEME_FIELDS = ["mainThemesEn", "mainThemesPt", "sessionThemesEn", "sessionThemesPt"] as const;

/**
 * Strip hidden sections from an event payload, in place (like the other `apply…`
 * payload helpers). Audio hidden: the sessions go entirely, since a session only
 * carries tracks. Video hidden: no videos. Transcripts hidden: no transcripts and no
 * read-along on the tracks. Texts hidden: no files and no linked publications (the
 * publications stay in their own catalogue). Topics hidden: the themes are nulled.
 * A `forthcoming` event is announced without any content, whatever its flags say: for a
 * non-admin it loses sessions, videos, transcripts, files, publications, themes and bibliography.
 * Call it before the tracks are enriched with `hasReadAlong`.
 */
export function applyContentVisibility(event: unknown, role: string | null | undefined): void {
  if (!event || typeof event !== "object") return;
  const ev = event as ContentFlags & Record<string, unknown> & {
    status?: unknown;
    sessions?: Array<{ tracks?: unknown[] }>;
  };
  if (ev.status === "forthcoming" && !isAdminRole(role)) {
    for (const field of ["sessions", "videos", "transcripts", "eventFiles", "eventPublications", "relatedPublications"]) {
      if (field in ev) ev[field] = [];
    }
    for (const field of [...THEME_FIELDS, "bibliography", "bibliographyPt"]) if (field in ev) ev[field] = null;
    return;
  }
  const visible = contentVisibleTo(ev, role);
  if (!visible.transcripts) {
    if (ev.transcripts) ev.transcripts = [];
    for (const session of ev.sessions ?? []) for (const track of session.tracks ?? []) clearReadAlong(track);
  }
  if (!visible.texts) {
    if (ev.eventFiles) ev.eventFiles = [];
    if (ev.eventPublications) ev.eventPublications = [];
    if (ev.relatedPublications) ev.relatedPublications = [];
  }
  if (!visible.topics) {
    for (const field of THEME_FIELDS) if (field in ev) ev[field] = null;
  }
  if (!visible.audio && ev.sessions) ev.sessions = [];
  if (!visible.video && ev.videos) ev.videos = [];
}

export function applyContentVisibilityToAll(
  events: unknown[],
  role: string | null | undefined,
): void {
  for (const event of events ?? []) applyContentVisibility(event, role);
}

/** The older names, kept so existing callers keep working. */
export const applyMediaVisibility = applyContentVisibility;
export const applyMediaVisibilityToAll = applyContentVisibilityToAll;

/** Clear the read-along of one track served on its own (track and session lookups, bookmarks). */
export function applyTrackReadAlongVisibility(
  track: unknown,
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
): void {
  if (event && !contentVisibleTo(event, role).transcripts) clearReadAlong(track);
}

function assertVisible(
  section: keyof ContentVisibility,
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  if (event && !contentVisibleTo(event, role)[section]) throw AppError.notFound(notFoundMessage);
}

/** 404 (as if the item did not exist) when the event's audio is hidden from the caller. */
export function assertAudioVisible(
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  assertVisible("audio", event, role, notFoundMessage);
}

/** 404 (as if the item did not exist) when the event's video is hidden from the caller. */
export function assertVideoVisible(
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  assertVisible("video", event, role, notFoundMessage);
}

/** 404 when the event's transcripts (and read-along) are hidden from the caller. */
export function assertTranscriptsVisible(
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  assertVisible("transcripts", event, role, notFoundMessage);
}

/** 404 when the event's texts (files and related publications) are hidden from the caller. */
export function assertTextsVisible(
  event: ContentFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  assertVisible("texts", event, role, notFoundMessage);
}
