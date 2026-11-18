import { and, eq, inArray, sql } from "drizzle-orm";
import { db as appDb, type Database } from "../db/index.ts";
import { userPublicationOpens } from "../db/schema/publications.ts";

/**
 * Per-user "last opened" times for publications, behind the app's
 * "Recently opened" tab. Each user only ever reads their own rows.
 *
 * The database is a parameter so the queries can be run against a throwaway
 * schema in tests; routes use the default.
 */

/** Record that `userId` opened `publicationId` now (first open or again). */
export async function recordPublicationOpen(
  userId: number,
  publicationId: number,
  database: Database = appDb,
): Promise<void> {
  await database
    .insert(userPublicationOpens)
    .values({ userId, publicationId })
    .onConflictDoUpdate({
      target: [userPublicationOpens.userId, userPublicationOpens.publicationId],
      set: {
        lastOpenedAt: sql`now()`,
        openCount: sql`${userPublicationOpens.openCount} + 1`,
      },
    });
}

/**
 * When `userId` last opened each of `publicationIds`. Publications they never
 * opened are absent from the map.
 */
export async function lastOpenedByPublication(
  userId: number,
  publicationIds: number[],
  database: Database = appDb,
): Promise<Map<number, Date>> {
  if (publicationIds.length === 0) return new Map();
  const rows = await database
    .select({
      publicationId: userPublicationOpens.publicationId,
      lastOpenedAt: userPublicationOpens.lastOpenedAt,
    })
    .from(userPublicationOpens)
    .where(
      and(
        eq(userPublicationOpens.userId, userId),
        inArray(userPublicationOpens.publicationId, publicationIds),
      ),
    );
  return new Map(rows.map((r) => [r.publicationId, r.lastOpenedAt]));
}
