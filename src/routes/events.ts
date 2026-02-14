import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { eventRetreatGroups } from "../db/schema/retreats.ts";
import { userGroupMemberships } from "../db/schema/users.ts";
import { downloadRequests } from "../db/schema/index.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { generateRetreatZip } from "../services/zip-generator.ts";

const eventRoutes = new Hono();

// All public routes require authentication
eventRoutes.use("*", authMiddleware);

/**
 * GET /api/events - List events accessible to the user
 * Filters by user's group memberships
 */
eventRoutes.get("/", async (c) => {
  const user = getUser(c);

  // Get user's group memberships
  const memberships = await db
    .select({ retreatGroupId: userGroupMemberships.retreatGroupId })
    .from(userGroupMemberships)
    .where(eq(userGroupMemberships.userId, user.id));

  const groupIds = memberships.map((m) => m.retreatGroupId);

  // Admin users can see all events
  if (user.role === "admin" || user.role === "superadmin") {
    const data = await db.query.events.findMany({
      where: eq(events.status, "published"),
      orderBy: (r, { desc }) => [desc(r.startDate)],
      with: {
        eventType: true,
        audience: true,
        eventTeachers: { with: { teacher: true } },
        eventRetreatGroups: { with: { retreatGroup: true } },
        eventPlaces: { with: { place: true } },
      },
    });
    return c.json(data);
  }

  // Regular users: find events linked to their groups
  if (groupIds.length === 0) {
    return c.json([]);
  }

  // Get event IDs linked to user's groups
  const eventLinks = await db
    .select({ eventId: eventRetreatGroups.eventId })
    .from(eventRetreatGroups)
    .where(inArray(eventRetreatGroups.retreatGroupId, groupIds));

  const accessibleEventIds = [...new Set(eventLinks.map((r) => r.eventId))];

  if (accessibleEventIds.length === 0) {
    return c.json([]);
  }

  const data = await db.query.events.findMany({
    where: and(
      eq(events.status, "published"),
      inArray(events.id, accessibleEventIds),
    ),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  return c.json(data);
});

/**
 * GET /api/events/:id - Event detail with sessions and tracks
 */
eventRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);

  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: {
      eventType: true,
      audience: true,
      sessions: {
        orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
        with: {
          tracks: {
            orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
          },
        },
      },
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  });

  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }

  return c.json(event);
});

/**
 * POST /api/events/:id/request-download - Request ZIP download for an event
 */
eventRoutes.post("/:id/request-download", async (c) => {
  const user = getUser(c);
  const eventId = parseInt(c.req.param("id"), 10);

  // Verify event exists
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: {
      eventRetreatGroups: true,
    },
  });

  if (!event) {
    throw AppError.notFound("Event not found");
  }

  // Verify user has access to this event (via group membership)
  const userGroups = await db
    .select({ retreatGroupId: userGroupMemberships.retreatGroupId })
    .from(userGroupMemberships)
    .where(eq(userGroupMemberships.userId, user.id));

  const userGroupIds = userGroups.map((g) => g.retreatGroupId);
  const eventGroupIds = event.eventRetreatGroups.map((g) => g.retreatGroupId);

  const hasAccess =
    user.role === "admin" ||
    user.role === "superadmin" ||
    eventGroupIds.some((id) => userGroupIds.includes(id));

  if (!hasAccess) {
    throw AppError.forbidden("Access denied to this event");
  }

  // Check for existing pending/processing request
  const existingRequest = await db.query.downloadRequests.findFirst({
    where: and(
      eq(downloadRequests.userId, user.id),
      eq(downloadRequests.eventId, eventId),
      inArray(downloadRequests.status, ["pending", "processing"]),
    ),
  });

  if (existingRequest) {
    // Return existing request ID
    return c.json({ request_id: existingRequest.id });
  }

  // Create new download request
  const [newRequest] = await db
    .insert(downloadRequests)
    .values({
      userId: user.id,
      eventId,
      status: "pending",
    })
    .returning();

  if (!newRequest) {
    throw new AppError(500, "Failed to create download request", "INTERNAL_ERROR");
  }

  // Start ZIP generation asynchronously (don't await)
  // This allows the endpoint to return immediately while processing continues
  generateRetreatZip(newRequest.id, eventId, user.id).catch((error) => {
    console.error(`[ZIP] Background generation failed for request ${newRequest.id}:`, error);
  });

  return c.json({ request_id: newRequest.id });
});

export { eventRoutes };
