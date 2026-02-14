import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventRetreatGroups, events } from "../db/schema/retreats.ts";
import { userGroupMemberships } from "../db/schema/users.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";

const groupRoutes = new Hono();

groupRoutes.use("*", authMiddleware);

/**
 * GET /api/groups - List groups the user belongs to
 */
groupRoutes.get("/", async (c) => {
  const user = getUser(c);

  // Admin sees all groups
  if (user.role === "admin" || user.role === "superadmin") {
    const data = await db.select().from(retreatGroups).orderBy(retreatGroups.displayOrder);
    return c.json(data);
  }

  // Regular user sees their groups
  const memberships = await db
    .select({ retreatGroupId: userGroupMemberships.retreatGroupId })
    .from(userGroupMemberships)
    .where(eq(userGroupMemberships.userId, user.id));

  const groupIds = memberships.map((m) => m.retreatGroupId);
  if (groupIds.length === 0) return c.json([]);

  const data = await db
    .select()
    .from(retreatGroups)
    .where(inArray(retreatGroups.id, groupIds))
    .orderBy(retreatGroups.displayOrder);

  return c.json(data);
});

/**
 * GET /api/groups/:id/events - List events for a group
 */
groupRoutes.get("/:id/events", async (c) => {
  const groupId = parseInt(c.req.param("id"), 10);

  const links = await db
    .select({ eventId: eventRetreatGroups.eventId })
    .from(eventRetreatGroups)
    .where(eq(eventRetreatGroups.retreatGroupId, groupId));

  const eventIds = links.map((l) => l.eventId);
  if (eventIds.length === 0) return c.json([]);

  const data = await db.query.events.findMany({
    where: and(
      inArray(events.id, eventIds),
      eq(events.status, "published"),
    ),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: {
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  return c.json(data);
});

export { groupRoutes };
