import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { syncVersions } from "../db/schema/sync-versions.ts";
import { userSyncVersions } from "../db/schema/user-sync-versions.ts";

export type SyncVersionMap = Record<string, number>;

export const TRACKED_NAMESPACES = ["events", "groups", "teachers", "publications"] as const;
export type Namespace = (typeof TRACKED_NAMESPACES)[number];

/**
 * Returns the current version counter for every tracked namespace.
 * The shape `{ events: 42, groups: 7, ... }` is what the client expects
 * from GET /api/sync/versions.
 */
export async function getAllVersions(): Promise<SyncVersionMap> {
  const rows = await db
    .select({ namespace: syncVersions.namespace, version: syncVersions.version })
    .from(syncVersions)
    .orderBy(syncVersions.namespace);

  const out: SyncVersionMap = {};
  for (const row of rows) {
    out[row.namespace] = row.version;
  }
  return out;
}

/**
 * Atomically increments the version counter for a namespace and updates
 * its updated_at timestamp. Throws if the namespace is not tracked.
 *
 * Called from admin CRUD routes after every create/update/delete on a
 * tracked entity. The bump is best-effort — failures are logged but do
 * not fail the originating mutation, since the client will recover on
 * the next sync poll.
 */
export async function bumpVersion(namespace: Namespace): Promise<void> {
  if (!TRACKED_NAMESPACES.includes(namespace)) {
    throw new Error(`unknown namespace: ${namespace}`);
  }

  await db
    .update(syncVersions)
    .set({
      version: sql`${syncVersions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(syncVersions.namespace, namespace));
}

/** Convenience wrapper for bumping multiple namespaces from a single
 * call site. Bumps run in parallel — each UPDATE targets a different
 * primary-key row, so there is no write conflict. */
export async function bumpVersions(namespaces: Namespace[]): Promise<void> {
  await Promise.all(namespaces.map((ns) => bumpVersion(ns)));
}

/**
 * Returns the current per-user access version counter. Returns 0 if the
 * user has no row yet (i.e. their access has never been changed by an admin).
 */
export async function getUserVersion(userId: number): Promise<number> {
  const row = await db
    .select({ version: userSyncVersions.version })
    .from(userSyncVersions)
    .where(eq(userSyncVersions.userId, userId))
    .limit(1);
  return row[0]?.version ?? 0;
}

/**
 * Atomically increments the per-user access version. Lazily creates the
 * row if absent. Called from admin routes that change a user's access
 * (group membership, event attendance, role/subscription changes).
 */
export async function bumpUserAccessVersion(userId: number): Promise<void> {
  await db
    .insert(userSyncVersions)
    .values({ userId, version: 1 })
    .onConflictDoUpdate({
      target: userSyncVersions.userId,
      set: {
        version: sql`${userSyncVersions.version} + 1`,
        updatedAt: new Date(),
      },
    });
}
