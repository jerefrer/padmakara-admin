import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { teachers } from "../db/schema/teachers.ts";
import { audiences } from "../db/schema/audiences.ts";
import { users } from "../db/schema/users.ts";
import { downloadRequests } from "../db/schema/index.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { generateRetreatZip } from "../services/zip-generator.ts";
import { checkEventAccess, filterAccessibleEvents, AUDIENCE_SLUGS } from "../services/access.ts";

const eventRoutes = new Hono();

// ─── Speaker name resolution ────────────────────────────────────────────

/** Cache of abbreviation → teacher name (loaded once, refreshed per request batch) */
let speakerNameCache: Map<string, string> | null = null;

async function getSpeakerNameMap(): Promise<Map<string, string>> {
  if (speakerNameCache) return speakerNameCache;
  const allTeachers = await db
    .select({ name: teachers.name, abbreviation: teachers.abbreviation, aliases: teachers.aliases })
    .from(teachers);
  const map = new Map<string, string>();
  for (const t of allTeachers) {
    map.set(t.abbreviation.toUpperCase(), t.name);
    for (const alias of t.aliases) {
      map.set(alias.toUpperCase(), t.name);
    }
  }
  speakerNameCache = map;
  // Invalidate after 5 minutes
  setTimeout(() => { speakerNameCache = null; }, 5 * 60 * 1000);
  return map;
}

/** Add speakerName and hasReadAlong to each track in-place, strip internal fields */
async function enrichTracksWithSpeakerNames(trackList: any[]): Promise<void> {
  if (!trackList.length) return;
  const nameMap = await getSpeakerNameMap();
  for (const track of trackList) {
    if (track.speaker) {
      track.speakerName = nameMap.get(track.speaker.toUpperCase()) ?? null;
    }
    // Expose hasReadAlong boolean, strip the internal S3 key
    track.hasReadAlong = !!track.readAlongS3Key;
    delete track.readAlongS3Key;
  }
}

// ─── Event relations used in queries ─────────────────────────────────────
const eventWith = {
  eventType: true,
  audience: true,
  eventTeachers: { with: { teacher: true } },
  eventRetreatGroups: { with: { retreatGroup: true } },
  eventPlaces: { with: { place: true } },
} as const;

const eventWithSessions = {
  ...eventWith,
  sessions: {
    orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
    with: {
      tracks: {
        orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
      },
    },
  },
  transcripts: true,
} as const;

// ─── Public endpoints (no auth) ──────────────────────────────────────────

/**
 * GET /api/events/public - List public events (no auth required)
 * Returns events with audience slug "free-anyone"
 */
eventRoutes.get("/public", async (c) => {
  // Find the public audience
  const publicAudience = await db.query.audiences.findFirst({
    where: eq(audiences.slug, AUDIENCE_SLUGS.PUBLIC),
  });

  if (!publicAudience) {
    return c.json([]);
  }

  const data = await db.query.events.findMany({
    where: and(
      eq(events.status, "published"),
      eq(events.audienceId, publicAudience.id),
    ),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: eventWithSessions,
  });

  return c.json(data);
});

/**
 * GET /api/events/public/:id - Public event detail (no auth required)
 * Only returns events with audience slug "free-anyone"
 */
eventRoutes.get("/public/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);

  const event = await db.query.events.findFirst({
    where: and(eq(events.id, id), eq(events.status, "published")),
    with: eventWithSessions,
  });

  if (!event) {
    throw AppError.notFound("Event not found");
  }

  // Only allow access to public events
  if (event.audience?.slug !== AUDIENCE_SLUGS.PUBLIC) {
    throw AppError.forbidden("This event requires authentication");
  }

  return c.json(event);
});

// ─── Authenticated endpoints ─────────────────────────────────────────────
eventRoutes.use("/*", authMiddleware);

/**
 * Helper: check event access for a regular user, throw on denied.
 */
async function requireEventAccess(
  userId: number,
  role: string,
  event: { id: number; audience?: { slug: string } | null },
) {
  if (role === "admin" || role === "superadmin") return;

  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!fullUser) throw AppError.unauthorized("User not found");

  const result = await checkEventAccess(
    {
      id: fullUser.id,
      role: fullUser.role,
      subscriptionStatus: fullUser.subscriptionStatus,
      subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
    },
    event,
  );

  if (!result.allowed) {
    throw AppError.forbidden(
      result.reason === "SUBSCRIPTION_REQUIRED"
        ? "Active subscription required"
        : result.reason === "GROUP_MEMBERSHIP_REQUIRED"
          ? "Group membership required"
          : result.reason === "EVENT_ATTENDANCE_REQUIRED"
            ? "Event attendance required"
            : "Access denied",
    );
  }
}

/**
 * GET /api/events/sessions/:sessionId - Session detail with tracks
 * Checks access via parent event's audience rules
 */
eventRoutes.get("/sessions/:sessionId", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const user = getUser(c);

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: {
      tracks: {
        orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
      },
      event: {
        with: { audience: true },
      },
    },
  });

  if (!session) {
    throw AppError.notFound("Session not found");
  }

  await requireEventAccess(user.id, user.role, session.event);
  await enrichTracksWithSpeakerNames(session.tracks);

  return c.json(session);
});

/**
 * GET /api/events/tracks/:trackId - Track detail
 * Checks access via parent event's audience rules
 */
eventRoutes.get("/tracks/:trackId", async (c) => {
  const trackId = parseInt(c.req.param("trackId"), 10);
  const user = getUser(c);

  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, trackId),
    with: {
      session: {
        with: {
          event: {
            with: { audience: true },
          },
        },
      },
    },
  });

  if (!track) {
    throw AppError.notFound("Track not found");
  }

  const event = track.session?.event;
  if (!event) {
    throw AppError.notFound("Track's event not found");
  }

  await requireEventAccess(user.id, user.role, event);
  await enrichTracksWithSpeakerNames([track]);

  return c.json(track);
});

/**
 * GET /api/events - List events accessible to the authenticated user
 * Uses audience-based access control
 */
eventRoutes.get("/", async (c) => {
  const user = getUser(c);

  // Admin users can see all published events
  if (user.role === "admin" || user.role === "superadmin") {
    const data = await db.query.events.findMany({
      where: eq(events.status, "published"),
      orderBy: (r, { desc }) => [desc(r.startDate)],
      with: eventWith,
    });
    return c.json(data);
  }

  // Regular users: fetch full user record for subscription check
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!fullUser) {
    throw AppError.unauthorized("User not found");
  }

  // Fetch all published events with audience info
  const allEvents = await db.query.events.findMany({
    where: eq(events.status, "published"),
    orderBy: (r, { desc }) => [desc(r.startDate)],
    with: eventWith,
  });

  // Filter by access control
  const accessibleEvents = await filterAccessibleEvents(
    {
      id: fullUser.id,
      role: fullUser.role,
      subscriptionStatus: fullUser.subscriptionStatus,
      subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
    },
    allEvents,
  );

  return c.json(accessibleEvents);
});

/**
 * GET /api/events/:id - Event detail with sessions and tracks
 * Checks access before returning
 */
eventRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const user = getUser(c);

  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    with: eventWithSessions,
  });

  if (!event) {
    throw AppError.notFound("Event not found");
  }

  await requireEventAccess(user.id, user.role, event);

  // Enrich all tracks with speaker names
  for (const session of (event as any).sessions ?? []) {
    await enrichTracksWithSpeakerNames(session.tracks ?? []);
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
      audience: true,
      eventRetreatGroups: true,
    },
  });

  if (!event) {
    throw AppError.notFound("Event not found");
  }

  // Use access control service instead of manual group check
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!fullUser) {
    throw AppError.unauthorized("User not found");
  }

  const accessResult = await checkEventAccess(
    {
      id: fullUser.id,
      role: fullUser.role,
      subscriptionStatus: fullUser.subscriptionStatus,
      subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
    },
    event,
  );

  if (!accessResult.allowed) {
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

  // Start ZIP generation asynchronously
  generateRetreatZip(newRequest.id, eventId, user.id).catch((error) => {
    console.error(`[ZIP] Background generation failed for request ${newRequest.id}:`, error);
  });

  return c.json({ request_id: newRequest.id });
});

export { eventRoutes };
