import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { retreats } from "../db/schema/retreats.ts";
import { retreatGroupRetreats } from "../db/schema/retreats.ts";
import { userGroupMemberships } from "../db/schema/users.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";

const retreatRoutes = new Hono();

// All public routes require authentication
retreatRoutes.use("*", authMiddleware);

/**
 * GET /api/retreats - List retreats accessible to the user
 * Filters by user's group memberships and retreat audience level
 */
retreatRoutes.get("/", async (c) => {
  const user = getUser(c);

  // Get user's group memberships
  const memberships = await db
    .select({ retreatGroupId: userGroupMemberships.retreatGroupId })
    .from(userGroupMemberships)
    .where(eq(userGroupMemberships.userId, user.id));

  const groupIds = memberships.map((m) => m.retreatGroupId);

  // Admin users can see all retreats
  if (user.role === "admin" || user.role === "superadmin") {
    const data = await db.query.retreats.findMany({
      where: eq(retreats.status, "published"),
      orderBy: (r, { desc }) => [desc(r.startDate)],
      with: {
        retreatTeachers: { with: { teacher: true } },
        retreatGroups: { with: { retreatGroup: true } },
        retreatPlaces: { with: { place: true } },
      },
    });
    return c.json(data);
  }

  // Regular users: find retreats linked to their groups
  if (groupIds.length === 0) {
    // Only public retreats if user has no group memberships
    const data = await db.query.retreats.findMany({
      where: and(
        eq(retreats.status, "published"),
        eq(retreats.audience, "public"),
      ),
      orderBy: (r, { desc }) => [desc(r.startDate)],
      with: {
        retreatTeachers: { with: { teacher: true } },
        retreatPlaces: { with: { place: true } },
      },
    });
    return c.json(data);
  }

  // Get retreat IDs linked to user's groups
  const retreatLinks = await db
    .select({ retreatId: retreatGroupRetreats.retreatId })
    .from(retreatGroupRetreats)
    .where(inArray(retreatGroupRetreats.retreatGroupId, groupIds));

  const accessibleRetreatIds = [...new Set(retreatLinks.map((r) => r.retreatId))];

  if (accessibleRetreatIds.length === 0) {
    return c.json([]);
  }

  const data = await db.query.retreats.findMany({
    where: and(
      eq(retreats.status, "published"),
      inArray(retreats.id, accessibleRetreatIds),
    ),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: {
      retreatTeachers: { with: { teacher: true } },
      retreatGroups: { with: { retreatGroup: true } },
      retreatPlaces: { with: { place: true } },
    },
  });

  return c.json(data);
});

/**
 * GET /api/retreats/:id - Retreat detail with sessions and tracks
 */
retreatRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);

  const retreat = await db.query.retreats.findFirst({
    where: eq(retreats.id, id),
    with: {
      sessions: {
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
        with: {
          tracks: {
            orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
          },
        },
      },
      retreatTeachers: { with: { teacher: true } },
      retreatGroups: { with: { retreatGroup: true } },
      retreatPlaces: { with: { place: true } },
    },
  });

  if (!retreat) {
    return c.json({ error: "Retreat not found" }, 404);
  }

  return c.json(retreat);
});

export { retreatRoutes };
