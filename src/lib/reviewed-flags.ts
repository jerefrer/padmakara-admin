/**
 * The `...Reviewed` flags mark a text an AI wrote and nobody has approved yet.
 * Once someone approves it, only new text may withdraw the approval: an AI
 * edit or a translation always writes new text together with `false`.
 *
 * A save built from a page opened before the approval sends the old `false`
 * with the text unchanged (the admin forms send whole rows). Writing that flag
 * back silently undid the approval (event 928, 2026-11-16), so the update
 * routes drop it instead.
 */

/** [text field, its reviewed flag] for each kind of row that carries flags. */
export type ReviewedPairs = ReadonlyArray<readonly [text: string, flag: string]>;

export const TITLE_REVIEWED_PAIRS: ReviewedPairs = [
  ["titleEn", "titleEnReviewed"],
  ["titlePt", "titlePtReviewed"],
];

export const EVENT_REVIEWED_PAIRS: ReviewedPairs = [
  ["eventCode", "eventCodeReviewed"],
  ...TITLE_REVIEWED_PAIRS,
  ["mainThemesEn", "mainThemesEnReviewed"],
  ["mainThemesPt", "mainThemesPtReviewed"],
  ["sessionThemesEn", "sessionThemesEnReviewed"],
  ["sessionThemesPt", "sessionThemesPtReviewed"],
  ["bibliography", "bibliographyEnReviewed"],
  ["bibliographyPt", "bibliographyPtReviewed"],
];

/** Whether the update tries to set any of the flags to false (only then is the stored row needed). */
export const unflagsAny = (data: Record<string, unknown>, pairs: ReviewedPairs): boolean =>
  pairs.some(([, flag]) => data[flag] === false);

const sameText = (a: unknown, b: unknown): boolean => (a ?? "") === (b ?? "");

/**
 * Remove from `data`, in place, every `false` flag that would withdraw a
 * stored approval while leaving its text as it is. `stored` is the row before
 * the update; without it (row not found) nothing is removed and the update
 * reports the missing row as usual.
 */
export function keepApprovals(
  data: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  pairs: ReviewedPairs,
): void {
  if (!stored) return;
  for (const [text, flag] of pairs) {
    if (data[flag] !== false || stored[flag] !== true) continue;
    const textChanges = text in data && !sameText(data[text], stored[text]);
    if (!textChanges) delete data[flag];
  }
}
