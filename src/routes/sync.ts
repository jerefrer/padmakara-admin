import { Hono } from "hono";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { getAllVersions, getUserVersion } from "../services/sync-versions.ts";

const syncRoutes = new Hono();

syncRoutes.use("*", authMiddleware);

/**
 * GET /api/sync/versions
 *
 * Returns per-namespace version tuples, e.g.
 * { events: { global: 42, user: 7 }, groups: { global: 12, user: 7 }, ... }
 *
 * The `global` counter is bumped when any entity in that namespace changes
 * (existing behavior). The `user` counter is bumped by admin actions that
 * change the authenticated user's access (group membership, event attendance,
 * role/subscription changes).
 *
 * The mobile app polls this endpoint on cold start, foreground (debounced
 * 5 min), and pull-to-refresh. When either `global` OR `user` differs from
 * the locally cached values, the client resyncs that namespace.
 *
 * Payload is small (~300 bytes) by design.
 */
syncRoutes.get("/versions", async (c) => {
  const user = getUser(c);
  const [globals, userVersion] = await Promise.all([
    getAllVersions(),
    getUserVersion(user.id),
  ]);
  const result: Record<string, { global: number; user: number }> = {};
  for (const [ns, global] of Object.entries(globals)) {
    result[ns] = { global, user: userVersion };
  }
  return c.json(result);
});

export { syncRoutes };
