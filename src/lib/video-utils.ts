import { buildThumbnailUrl } from "../services/bunny.ts";

/**
 * Populate `posterUrl` on each session video with a signed Bunny thumbnail URL.
 *
 * The DB column `session_videos.poster_url` is intentionally left null (we don't
 * store the CDN hostname), so the video grid has no image to show. Compute a
 * signed thumbnail on read instead — mirrors how playback URLs are signed on
 * the fly. Guarded so a missing Bunny config never breaks the event response.
 */
export function applyEventVideoThumbnails(event: unknown): void {
  const ev = event as { sessions?: { videos?: { bunnyVideoId?: string | null; posterUrl?: string | null }[] }[] } | null;
  if (!ev?.sessions) return;
  for (const session of ev.sessions) {
    for (const video of session.videos ?? []) {
      if (!video?.bunnyVideoId) continue;
      try {
        video.posterUrl = buildThumbnailUrl(video.bunnyVideoId);
      } catch {
        // Bunny not configured — leave posterUrl as-is.
      }
    }
  }
}

export function applyEventsVideoThumbnails(events: unknown[]): void {
  for (const event of events ?? []) applyEventVideoThumbnails(event);
}
