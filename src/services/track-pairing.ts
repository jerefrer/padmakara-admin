/**
 * Pairing a translation track with the original it translates.
 *
 * The app welds a pair into one row by comparing track numbers
 * (`isContinuation` in the retreat screen keys on `prevTrack.order ===
 * track.order`), so a pair only reads as one teaching when the translation
 * carries its original's number. The archive numbers files sequentially
 * instead — `286 [TIB] KPS Motivation.mp3`, `287 [ENG] KPS Motivation.mp3` —
 * so every pair currently renders as two unrelated rows.
 *
 * Two conventions coexist in the archive, so there are two rules, tried in
 * this order:
 *
 * 1. **Shared number.** The older recordings already pair by number —
 *    `001 JKR Initial Prayers.mp3` beside `001 TRAD Oracoes Iniciais.mp3`.
 *    Nothing needs renumbering there, only the `original_track_id` link, and
 *    titles cannot be compared because the Portuguese one is genuinely
 *    translated. The shared number is the evidence, so it is trusted over the
 *    titles — but only when exactly one original holds that number.
 * 2. **Adjacency and title.** The newer recordings number sequentially —
 *    `286 [TIB] KPS Motivation.mp3`, `287 [ENG] KPS Motivation.mp3` — so the
 *    translation has to move onto its original's number. Here a translation
 *    pairs only with the track *immediately* before it, titles matching.
 *
 * Both rules are the strictest the data supports, because neither has a safe
 * answer when the shape is ambiguous: a session holding "Verse 88" three
 * times in Tibetan and once in English, or an English track sitting *before*
 * its Tibetan original. Those decline rather than guess.
 */

/** The track fields the pairing rule reads. */
export interface PairableTrack {
  id: number;
  trackNumber: number;
  title: string;
  isTranslation: boolean;
  originalLanguage: string;
}

/** One translation to renumber onto its original. */
export interface PairPlanEntry {
  translationId: number;
  originalId: number;
  fromTrackNumber: number;
  toTrackNumber: number;
}

/** Why a translation was left alone, so a dry run can be read and trusted. */
export type UnpairedReason =
  | "no-preceding-track"
  | "preceding-is-a-translation"
  | "title-differs"
  | "same-language-as-original"
  | "original-already-paired"
  | "ambiguous-shared-number";

export interface UnpairedTrack {
  trackId: number;
  trackNumber: number;
  title: string;
  reason: UnpairedReason;
}

export interface PairPlan {
  pairs: PairPlanEntry[];
  unpaired: UnpairedTrack[];
}

/**
 * Titles are compared loosely: the archive's filenames produce stray casing
 * and double spaces, which should not stop a pair from being recognised.
 */
export function normalizeTrackTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Plan the renumbering for one session. Pure: it reads tracks and returns
 * intent, so the rule can be tested without a database and reviewed before
 * anything is written.
 *
 * Originals are never touched. A translation keeps its own number unless it
 * pairs, so declining to pair always leaves the data exactly as it is.
 */
export function planSessionPairing(tracks: PairableTrack[]): PairPlan {
  const ordered = [...tracks].sort(
    (a, b) => a.trackNumber - b.trackNumber || a.id - b.id,
  );

  const pairs: PairPlanEntry[] = [];
  const unpaired: UnpairedTrack[] = [];
  const claimed = new Set<number>();

  const originalsByNumber = new Map<number, PairableTrack[]>();
  for (const track of ordered) {
    if (track.isTranslation) continue;
    const atNumber = originalsByNumber.get(track.trackNumber) ?? [];
    atNumber.push(track);
    originalsByNumber.set(track.trackNumber, atNumber);
  }

  for (const [i, track] of ordered.entries()) {
    if (!track.isTranslation) continue;

    const decline = (reason: UnpairedReason) =>
      unpaired.push({
        trackId: track.id,
        trackNumber: track.trackNumber,
        title: track.title,
        reason,
      });

    const pair = (original: PairableTrack) => {
      claimed.add(original.id);
      // Emitted even when the numbers already match: a pair is a pair, and
      // the `original_track_id` link is worth recording whether or not any
      // renumbering follows from it. Callers compare the two numbers to tell
      // which rows actually move.
      pairs.push({
        translationId: track.id,
        originalId: original.id,
        fromTrackNumber: track.trackNumber,
        toTrackNumber: original.trackNumber,
      });
    };

    // Rule 1 — an original already sits at this number. Titles are not
    // compared: in the older recordings the translated title is a real
    // translation, and the shared number is the stronger evidence anyway.
    const sharing = originalsByNumber.get(track.trackNumber) ?? [];
    if (sharing.length > 0) {
      const candidates = sharing.filter(
        (o) => o.originalLanguage !== track.originalLanguage,
      );
      if (candidates.length > 1) {
        decline("ambiguous-shared-number");
        continue;
      }
      const [original] = candidates;
      if (!original) {
        decline("same-language-as-original");
        continue;
      }
      if (claimed.has(original.id)) {
        decline("original-already-paired");
        continue;
      }
      pair(original);
      continue;
    }

    // Rule 2 — nothing at this number, so the translation has to move.
    const previous = i > 0 ? ordered[i - 1] : undefined;
    if (!previous) {
      decline("no-preceding-track");
      continue;
    }
    if (previous.isTranslation) {
      decline("preceding-is-a-translation");
      continue;
    }
    if (normalizeTrackTitle(previous.title) !== normalizeTrackTitle(track.title)) {
      decline("title-differs");
      continue;
    }
    // The unique constraint is (session_id, track_number, original_language),
    // so a pair can only share a number when the two sides differ in
    // language. Same language means this is not a translation pair at all.
    if (previous.originalLanguage === track.originalLanguage) {
      decline("same-language-as-original");
      continue;
    }
    if (claimed.has(previous.id)) {
      decline("original-already-paired");
      continue;
    }

    pair(previous);
  }

  return { pairs, unpaired };
}

/**
 * Guard against a plan that would break the unique constraint — two tracks
 * of the same language landing on the same number. The rule cannot produce
 * one, which is exactly why this is worth asserting before a write to
 * production rather than trusting the reasoning.
 */
export function findPlanCollisions(
  tracks: PairableTrack[],
  plan: PairPlan,
): string[] {
  const moved = new Map(plan.pairs.map((p) => [p.translationId, p.toTrackNumber]));
  const seen = new Map<string, number>();
  const collisions: string[] = [];

  for (const track of tracks) {
    const key = `${moved.get(track.id) ?? track.trackNumber}|${track.originalLanguage}`;
    const other = seen.get(key);
    if (other !== undefined) {
      collisions.push(
        `tracks ${other} and ${track.id} would both hold number ${key.split("|")[0]} in ${track.originalLanguage}`,
      );
    } else {
      seen.set(key, track.id);
    }
  }

  return collisions;
}
