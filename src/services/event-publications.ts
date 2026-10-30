import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { publications, publicationRetreatGroups } from "../db/schema/publications.ts";

type PublicationRow = typeof publications.$inferSelect;

/**
 * Publications whose retreat groups include at least one of `groupIds`: the
 * texts an event receives automatically through its groups. Each publication
 * appears once, newest first. No status or audience filtering happens here;
 * callers decide who may see what (`openablePublications`).
 */
export async function publicationsViaGroups(groupIds: number[]): Promise<PublicationRow[]> {
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
 * Direct links first (in their stored order), then the group-linked ones;
 * a publication linked both ways appears once.
 */
export function mergePublications<T extends { id: number }>(direct: T[], viaGroups: T[]): T[] {
  const seen = new Set<number>();
  const merged: T[] = [];
  for (const pub of [...direct, ...viaGroups]) {
    if (seen.has(pub.id)) continue;
    seen.add(pub.id);
    merged.push(pub);
  }
  return merged;
}
