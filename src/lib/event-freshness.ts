type DateLike = Date | string | null | undefined;

interface Stampable {
  updatedAt: DateLike;
  eventTeachers?: Array<{ teacher?: { updatedAt?: DateLike } | null }>;
  eventRetreatGroups?: Array<{ retreatGroup?: { updatedAt?: DateLike } | null }>;
}

const time = (value: DateLike): number => (value ? new Date(value).getTime() : 0);

/**
 * The apps cache the event list and refetch an event only when its `updatedAt`
 * changes. Each event carries its teachers' and retreat groups' pictures and
 * framing, so a teacher or group edit must look like an edit of the event too,
 * or phones keep the old framing until the event itself changes. This sets
 * `updatedAt` on the response to the newest of the three; the stored column,
 * which the admin shows as "Last edited", is untouched.
 */
export function stampEffectiveUpdatedAt<T extends Stampable>(list: T[]): T[] {
  for (const event of list) {
    let newest = time(event.updatedAt);
    for (const link of event.eventTeachers ?? []) newest = Math.max(newest, time(link.teacher?.updatedAt));
    for (const link of event.eventRetreatGroups ?? []) {
      newest = Math.max(newest, time(link.retreatGroup?.updatedAt));
    }
    if (newest > time(event.updatedAt)) event.updatedAt = new Date(newest);
  }
  return list;
}
