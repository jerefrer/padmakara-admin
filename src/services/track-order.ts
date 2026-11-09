import { asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Track order within a session. Tracks come in by number, in the order the
 * files were named; an admin can then move any track up or down, which saves
 * a position for every track of that session. Tracks without a position
 * (never reordered, or added or moved in afterwards) follow, by number.
 */
export function trackOrderBy(t: { position: typeof tracks.position; trackNumber: typeof tracks.trackNumber }): SQL[] {
  return [sql`${t.position} asc nulls last`, asc(t.trackNumber)];
}

/** Why a requested order is unusable, or null when it lists each track of the session exactly once. */
export function trackOrderProblem(sessionTrackIds: number[], requested: number[]): string | null {
  const unique = new Set(requested);
  if (unique.size !== requested.length) return "A track appears twice in the new order.";
  const inSession = new Set(sessionTrackIds);
  if (requested.some((id) => !inSession.has(id))) return "The new order lists a track from another session.";
  if (unique.size !== inSession.size) return "The new order must list every track of the session.";
  return null;
}

/** Save `trackIds` as the session's order: positions 1, 2, 3… */
export async function setSessionTrackOrder(sessionId: number, trackIds: number[]): Promise<void> {
  const current = await db.query.tracks.findMany({
    columns: { id: true },
    where: eq(tracks.sessionId, sessionId),
  });
  const problem = trackOrderProblem(
    current.map((t) => t.id),
    trackIds,
  );
  if (problem) throw AppError.badRequest(problem, "TRACK_ORDER_MISMATCH");

  await db.transaction(async (tx) => {
    for (const [index, id] of trackIds.entries()) {
      await tx.update(tracks).set({ position: index + 1 }).where(eq(tracks.id, id));
    }
  });
}
