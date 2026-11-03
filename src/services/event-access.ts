import { db } from "../db/index.ts";
import { eventAccessGrants } from "../db/schema/event-access.ts";
import { bumpUserAccessVersion } from "./sync-versions.ts";

/**
 * Give a user access to one event. Idempotent: an existing grant wins and
 * nothing changes. The user's sync version is bumped only when a grant was
 * actually created, so clients refetch exactly once.
 */
export async function grantEventAccess(input: {
  userId: number;
  eventId: number;
  source: "purchase" | "free" | "manual";
  orderId?: number;
  grantedBy?: number;
}): Promise<{ created: boolean }> {
  const rows = await db
    .insert(eventAccessGrants)
    .values({
      userId: input.userId,
      eventId: input.eventId,
      source: input.source,
      orderId: input.orderId ?? null,
      grantedBy: input.grantedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ userId: eventAccessGrants.userId });

  if (rows.length === 0) return { created: false };
  await bumpUserAccessVersion(input.userId);
  return { created: true };
}
