/**
 * Related texts of an event. A publication is shown on an event only when an
 * admin ticked it there (`event_publications`). The retreat groups ticked on a
 * publication decide who may open it, never which events list it, so there is
 * no group-derived listing any more. `publicationsOfEventGroups` exists only to
 * suggest candidates in the admin's tick list.
 */

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { publications, publicationRetreatGroups } from "../db/schema/publications.ts";

type PublicationRow = typeof publications.$inferSelect;

/**
 * Publications whose retreat groups include at least one of `groupIds`, each
 * once, newest first. Admin suggestions only: no status or audience filtering.
 */
export async function publicationsOfEventGroups(groupIds: number[]): Promise<PublicationRow[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ publication: publications })
    .from(publicationRetreatGroups)
    .innerJoin(publications, eq(publications.id, publicationRetreatGroups.publicationId))
    .where(inArray(publicationRetreatGroups.retreatGroupId, groupIds))
    .orderBy(desc(publications.publicationDate), desc(publications.id));
  const seen = new Set<number>();
  const result: PublicationRow[] = [];
  for (const { publication } of rows) {
    if (seen.has(publication.id)) continue;
    seen.add(publication.id);
    result.push(publication);
  }
  return result;
}

/**
 * Newest publication date first, then highest id: the ticked links carry no
 * position, so this keeps the order on the event page stable.
 */
export function newestFirst<T extends { id: number; publicationDate?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const da = a.publicationDate ?? "";
    const db_ = b.publicationDate ?? "";
    if (da !== db_) return da < db_ ? 1 : -1;
    return b.id - a.id;
  });
}
