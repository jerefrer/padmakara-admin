/**
 * Loads a video's slide document so the intro subtitle cues can be merged into
 * a VTT on its way out of the system (track.vtt, Bunny captions, admin
 * download). The merge itself is the pure function in
 * src/lib/slides/intro-subtitles.ts.
 *
 * The stored document is used whatever the burn status says: while a re-burn is
 * pending the slides may differ from what was burned, and the cues then follow
 * the saved document rather than the file. That is deliberate — it is the only
 * document there is — and a re-burn brings the two back together.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { mergeIntroSubtitleCues } from "../lib/slides/intro-subtitles.ts";
import type { SlideDocument } from "../lib/slides/types.ts";

export async function getVideoSlides(videoId: number): Promise<SlideDocument | null> {
  const row = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
    columns: { slides: true },
  });
  return row?.slides ?? null;
}

/** Merge the intro cues of a video, looked up by id, into `vtt`. */
export async function withIntroSubtitlesForVideo(
  vtt: string,
  videoId: number,
  lang: string,
): Promise<string> {
  return mergeIntroSubtitleCues(vtt, await getVideoSlides(videoId), lang);
}
