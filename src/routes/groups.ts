import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventRetreatGroups, events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { filterAccessibleEvents } from "../services/access.ts";

const groupRoutes = new Hono();

groupRoutes.use("*", authMiddleware);

// ─── Shared: get full user record for access checks ───────────────
async function getFullUser(userId: number) {
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!fullUser) throw AppError.unauthorized("User not found");
  return {
    id: fullUser.id,
    role: fullUser.role,
    subscriptionStatus: fullUser.subscriptionStatus,
    subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
  };
}

/**
 * GET /api/groups - List groups that contain events the user can access.
 * Derives groups from accessible events rather than explicit memberships,
 * so event-participants and other audience types work correctly.
 */
groupRoutes.get("/", async (c) => {
  const user = getUser(c);

  // Admin sees all groups
  if (user.role === "admin" || user.role === "superadmin") {
    const data = await db.select().from(retreatGroups).orderBy(retreatGroups.displayOrder);
    return c.json(data);
  }

  // Get all published events with audience + retreat group info
  const allEvents = await db.query.events.findMany({
    where: eq(events.status, "published"),
    with: {
      audience: true,
      eventRetreatGroups: { with: { retreatGroup: true } },
    },
  });

  // Filter to events the user can access
  const fullUser = await getFullUser(user.id);
  const accessibleEvents = await filterAccessibleEvents(fullUser, allEvents);

  // Extract unique retreat groups from accessible events
  const groupMap = new Map<number, typeof retreatGroups.$inferSelect>();
  for (const event of accessibleEvents) {
    for (const erg of (event as any).eventRetreatGroups || []) {
      const rg = erg.retreatGroup;
      if (rg && !groupMap.has(rg.id)) {
        groupMap.set(rg.id, rg);
      }
    }
  }

  // Sort by displayOrder
  const data = [...groupMap.values()].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  );

  return c.json(data);
});

/**
 * GET /api/groups/:id/events - List events for a group
 * Access: events are filtered by audience-based access control.
 * No explicit group membership required — if a user can access events
 * in this group (e.g. via event-participants), they'll see them.
 */
groupRoutes.get("/:id/events", async (c) => {
  const groupId = parseInt(c.req.param("id"), 10);
  const user = getUser(c);

  // Verify group exists
  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, groupId),
  });
  if (!group) {
    throw AppError.notFound("Group not found");
  }

  // Get events linked to this group
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
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      sessions: {
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
        with: {
          tracks: {
            orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
          },
        },
      },
    },
  });

  // Filter events by audience-based access control
  const fullUser = await getFullUser(user.id);
  const accessibleEvents = await filterAccessibleEvents(fullUser, data);

  return c.json(accessibleEvents);
});

export { groupRoutes };
