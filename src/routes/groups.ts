import { Hono } from "hono";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventRetreatGroups, events } from "../db/schema/retreats.ts";
import { users, userGroupMemberships } from "../db/schema/users.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { AUDIENCE_SLUGS, filterAccessibleEvents, eventStatusVisibleTo } from "../services/access.ts";
import { resolveEventsTeacherUrls } from "../lib/teacher-utils.ts";
import { applyEventsOrganizers, eventOrganizersWith } from "../lib/organizer-utils.ts";
import { resolveGroupsUrls, resolveEventsGroupUrls } from "../lib/group-utils.ts";
import { applyContentVisibilityToAll } from "../services/media-visibility.ts";
import { trackOrderBy } from "../services/track-order.ts";

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
    const resolved = await resolveGroupsUrls(data);
    return c.json(resolved);
  }

  // Get all published events with audience + retreat group info
  const allEvents = await db.query.events.findMany({
    where: eq(events.status, "published"),
    with: {
      audience: true,
      eventRetreatGroups: { with: { retreatGroup: true } },
    },
  });

  // Filter to events the audience rules open for the user. Grants and membership inclusion
  // are left out on purpose: buying one teaching must not add its whole group to the list.
  const fullUser = await getFullUser(user.id);
  const accessibleEvents = await filterAccessibleEvents(fullUser, allEvents, { audienceOnly: true });

  const memberships = await db.query.userGroupMemberships.findMany({
    where: eq(userGroupMemberships.userId, user.id),
  });
  const memberOf = new Set(memberships.map((m) => m.retreatGroupId));

  // Extract unique retreat groups from accessible events
  const groupMap = new Map<number, typeof retreatGroups.$inferSelect>();
  for (const event of accessibleEvents) {
    const linked: any[] = (event as any).eventRetreatGroups || [];
    // An event shared by several groups must not list the ones the user is not in.
    // A member of none of them got in as an attendee, and keeps seeing them all.
    const restrictToMemberships =
      (event as any).audience?.slug === AUDIENCE_SLUGS.GROUP_MEMBERS &&
      linked.some((erg) => memberOf.has(erg.retreatGroup?.id));
    for (const erg of linked) {
      const rg = erg.retreatGroup;
      if (restrictToMemberships && !memberOf.has(rg?.id)) continue;
      if (rg && !groupMap.has(rg.id)) {
        groupMap.set(rg.id, rg);
      }
    }
  }

  // Sort by displayOrder
  const data = [...groupMap.values()].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
  );

  const resolved = await resolveGroupsUrls(data);
  return c.json(resolved);
});

/**
 * GET /api/groups/:id/events - List events for a group
 * Access: events are filtered by audience-based access control.
 * No explicit group membership required — if a user can access events
 * in this group (e.g. via event-participants), they'll see them.
 */
groupRoutes.get("/:id/events", async (c) => {
  const idParam = c.req.param("id");
  const user = getUser(c);

  // Resolve group by numeric id, abbreviation (case-insensitive), or slug.
  const numericId = /^\d+$/.test(idParam) ? parseInt(idParam, 10) : null;
  const group = await db.query.retreatGroups.findFirst({
    where: numericId !== null
      ? eq(retreatGroups.id, numericId)
      : or(
          sql`lower(${retreatGroups.abbreviation}) = lower(${idParam})`,
          eq(retreatGroups.slug, idParam),
        ),
  });
  if (!group) {
    throw AppError.notFound("Group not found");
  }
  const groupId = group.id;

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
      inArray(events.status, eventStatusVisibleTo(user.role)),
    ),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: {
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventPlaces: { with: { place: true } },
      eventOrganizers: eventOrganizersWith,
      eventRetreatGroups: { with: { retreatGroup: true } },
      sessions: {
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
        with: {
          tracks: {
            orderBy: (t: any) => trackOrderBy(t),
          },
        },
      },
      videos: {
        orderBy: (v: any, { asc }: any) => [asc(v.position)],
      },
    },
  });

  // Filter events by audience-based access control
  const fullUser = await getFullUser(user.id);
  const accessibleEvents = await filterAccessibleEvents(fullUser, data);

  applyContentVisibilityToAll(accessibleEvents, user.role);
  await resolveEventsTeacherUrls(accessibleEvents);
  await resolveEventsGroupUrls(accessibleEvents);
  applyEventsOrganizers(accessibleEvents);
  return c.json(accessibleEvents);
});

export { groupRoutes };
