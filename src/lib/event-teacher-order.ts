/**
 * Display order of an event's teachers (`retreat_teachers`). Pure, so the slide
 * templates and the import script can use it without loading the S3 client.
 */

/** The `retreat_teachers.role` of a guest / other speaker; anything else is a main teacher. */
export const GUEST_ROLE = "guest";

/**
 * An event's teacher links in display order: the main teachers first, then the guests,
 * each by their saved `position`. The sort is stable, so ties (and rows loaded without
 * a position) keep the order they were loaded in.
 */
export function orderEventTeachers<T extends { role?: string | null; position?: number | null }>(
  eventTeachers: readonly T[] | null | undefined,
): T[] {
  const rank = (et: T) => (et.role === GUEST_ROLE ? 1 : 0);
  return [...(eventTeachers ?? [])].sort(
    (a, b) => rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0),
  );
}
