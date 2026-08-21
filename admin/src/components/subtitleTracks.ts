/**
 * Pure helpers for the admin video preview's subtitle selector.
 *
 * Subtitles in this system are soft WebVTT tracks (never burned into the
 * video), served as HLS SUBTITLES renditions that are off by default. The
 * preview player reads its available tracks from whichever engine is playing —
 * hls.js `subtitleTracks` on Chrome/Firefox, or the native `<video>`
 * `textTracks` list on Safari — and both are normalized through
 * `buildSubtitleOptions` into a single selector shape.
 */

/** A subtitle track as reported by hls.js or a native `<video>` element. */
export interface SubtitleTrackDescriptor {
  /**
   * The value used to select this track later: the hls.js track `id`, or the
   * track's index within the native `textTracks` list.
   */
  id: number;
  lang: string | null | undefined;
  label: string | null | undefined;
  /** Native `TextTrack.kind`; absent for hls.js tracks (always subtitles). */
  kind?: string;
}

/** One entry in the subtitle selector. */
export interface SubtitleOption {
  /** `id` of the track to show, or `SUBTITLES_OFF` to disable subtitles. */
  value: number;
  label: string;
}

/** Sentinel selector value that turns subtitles off. */
export const SUBTITLES_OFF = -1;

/**
 * Normalize subtitle track descriptors into selector options.
 *
 * Prepends an "Off" entry, keeps only subtitle/caption kinds, de-dupes by id,
 * and gives every track a human label — the manifest label if present, else the
 * uppercased language code, else a numbered "Subtitle N" fallback.
 */
export function buildSubtitleOptions(
  tracks: SubtitleTrackDescriptor[],
  offLabel: string,
): SubtitleOption[] {
  const options: SubtitleOption[] = [{ value: SUBTITLES_OFF, label: offLabel }];
  const seen = new Set<number>();
  let n = 0;
  for (const track of tracks) {
    if (track.kind && track.kind !== "subtitles" && track.kind !== "captions") {
      continue;
    }
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    n += 1;
    const label =
      track.label?.trim() || track.lang?.trim().toUpperCase() || `Subtitle ${n}`;
    options.push({ value: track.id, label });
  }
  return options;
}
