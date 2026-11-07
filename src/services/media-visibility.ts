import { AppError } from "../lib/errors.ts";

/**
 * Per-media visibility of a published event.
 *
 * An event can go live with only its audio or only its video showing (the other is
 * still being edited). The flags live on the event (`audioPublished`, `videoPublished`)
 * and are enforced here, server-side, for every app-facing route: a hidden track or
 * video is never returned and is a 404 when requested directly, so nothing reveals it
 * exists. Admins and superadmins always see everything, like they see drafts.
 *
 * Keep the rule in this file: routes call these helpers rather than testing the flags.
 */

export interface MediaFlags {
  audioPublished?: boolean | null;
  videoPublished?: boolean | null;
}

export interface MediaVisibility {
  audio: boolean;
  video: boolean;
}

function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

/** What the caller may see of an event's media. A missing flag counts as visible. */
export function mediaVisibleTo(
  event: MediaFlags,
  role: string | null | undefined,
): MediaVisibility {
  if (isAdminRole(role)) return { audio: true, video: true };
  return {
    audio: event.audioPublished !== false,
    video: event.videoPublished !== false,
  };
}

/**
 * Strip hidden media from an event payload, in place (like the other `apply…`
 * payload helpers). Audio hidden: the sessions go entirely, since a session only
 * carries tracks (transcripts and files stay, they are texts). Video hidden: no videos.
 */
export function applyMediaVisibility(event: unknown, role: string | null | undefined): void {
  if (!event || typeof event !== "object") return;
  const ev = event as MediaFlags & { sessions?: unknown[]; videos?: unknown[] };
  const visible = mediaVisibleTo(ev, role);
  if (!visible.audio && ev.sessions) ev.sessions = [];
  if (!visible.video && ev.videos) ev.videos = [];
}

export function applyMediaVisibilityToAll(
  events: unknown[],
  role: string | null | undefined,
): void {
  for (const event of events ?? []) applyMediaVisibility(event, role);
}

/** 404 (as if the item did not exist) when the event's audio is hidden from the caller. */
export function assertAudioVisible(
  event: MediaFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  if (event && !mediaVisibleTo(event, role).audio) throw AppError.notFound(notFoundMessage);
}

/** 404 (as if the item did not exist) when the event's video is hidden from the caller. */
export function assertVideoVisible(
  event: MediaFlags | null | undefined,
  role: string | null | undefined,
  notFoundMessage: string,
): void {
  if (event && !mediaVisibleTo(event, role).video) throw AppError.notFound(notFoundMessage);
}
