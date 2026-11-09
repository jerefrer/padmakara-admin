/**
 * Hand-set track order within a session (the ↑/↓ arrows on each track). The
 * API saves a position for every track of the session; tracks without one
 * follow by number, the original ahead of its translations.
 */

const LANG_ORDER: Record<string, number> = { en: 0, pt: 1, es: 2, fr: 3 };

interface OrderedTrack {
  trackNumber: number;
  position?: number | null;
  isTranslation?: boolean;
  originalLanguage?: string;
}

/** Sort comparator matching the API: saved position first, then number. */
export function compareTracks(a: OrderedTrack, b: OrderedTrack): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
  const transOrd = (a.isTranslation ? 1 : 0) - (b.isTranslation ? 1 : 0);
  if (transOrd !== 0) return transOrd;
  return (LANG_ORDER[a.originalLanguage ?? ""] ?? 4) - (LANG_ORDER[b.originalLanguage ?? ""] ?? 4);
}

/**
 * The session's track ids after moving the track at `index` one step up (-1)
 * or down (1), or null when it cannot move (first/last, or an unsaved track).
 */
export function movedTrackIds(tracks: ReadonlyArray<{ id?: number }>, index: number, delta: -1 | 1): number[] | null {
  const target = index + delta;
  if (index < 0 || index >= tracks.length || target < 0 || target >= tracks.length) return null;
  const ids = tracks.map((t) => t.id);
  if (ids.some((id) => id === undefined)) return null;
  const next = [...(ids as number[])];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
