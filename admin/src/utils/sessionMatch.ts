import type { InferredSession } from "./trackParser";

/**
 * Find the existing session a newly inferred session should merge into: same
 * date and same period. Sessions without both a date and a period never match,
 * so undated tracks keep creating their own session.
 *
 * `toIso` normalises each side ("October 10" or an ISO date) to YYYY-MM-DD.
 */
export function findMatchingExistingSession<
  T extends Pick<InferredSession, "date" | "timePeriod">,
>(
  existing: Array<T & { id?: number }>,
  incoming: Pick<InferredSession, "date" | "timePeriod">,
  toIso: (date: string | null) => string | null,
): (T & { id?: number }) | undefined {
  if (!incoming.date || !incoming.timePeriod) return undefined;
  const wanted = toIso(incoming.date);
  if (!wanted) return undefined;
  return existing.find(
    (s) =>
      s.id !== undefined &&
      s.timePeriod === incoming.timePeriod &&
      toIso(s.date) === wanted,
  );
}
