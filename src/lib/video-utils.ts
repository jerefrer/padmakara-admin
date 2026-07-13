import { buildThumbnailUrl } from "../services/bunny.ts";

/**
 * Ensure each session video has a `posterUrl` for the grid.
 *
 * `session_videos.poster_url` is the optional CUSTOM-poster override (a full
 * URL an admin can set for a nicer/branded thumbnail). It's normally null, so
 * we fall back to Bunny's auto-generated thumbnail — computed as a signed URL
 * on read (the DB never stores the CDN hostname, and the pull zone enforces CDN
 * token auth). A stored custom poster wins. Guarded so a missing Bunny config
 * never breaks the event response.
 */
export function applyEventVideoThumbnails(event: unknown): void {
  const ev = event as { sessions?: { videos?: { bunnyVideoId?: string | null; posterUrl?: string | null }[] }[] } | null;
  if (!ev?.sessions) return;
  for (const session of ev.sessions) {
    for (const video of session.videos ?? []) {
      if (!video?.bunnyVideoId) continue;
      if (video.posterUrl) continue; // custom poster override — keep it
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
