import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.ts";
import { userProgress, bookmarks, eventBookmarks, trackBookmarks } from "../db/schema/user-content.ts";
import { videoProgress } from "../db/schema/video-progress.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import {
  updateProgressSchema,
  createBookmarkSchema,
  createEventBookmarkSchema,
  createTrackBookmarkSchema,
} from "../lib/schemas.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { checkEventAccess } from "../services/access.ts";
import { users } from "../db/schema/users.ts";
import { resolveEventTeacherUrls, resolveEventsTeacherUrls } from "../lib/teacher-utils.ts";
import { resolveEventGroupUrls, resolveEventsGroupUrls } from "../lib/group-utils.ts";
import { z } from "zod";

const contentRoutes = new Hono();

contentRoutes.use("*", authMiddleware);

// --- Progress ---

/**
 * GET /api/content/progress - Return all listening-progress rows for the
 * current user, ordered by `lastPlayed` descending. Used by the mobile
 * client to bulk-sync at app start / foreground resume; the per-track
 * variant (GET /progress/:trackId) is kept for legacy single-row reads.
 */
contentRoutes.get("/progress", async (c) => {
  const user = getUser(c);
  const rows = await db.query.userProgress.findMany({
    where: eq(userProgress.userId, user.id),
    orderBy: (up, { desc }) => [desc(up.lastPlayed)],
  });
  return c.json(rows);
});

/**
 * POST /api/content/progress - Save/update listening progress
 */
contentRoutes.post("/progress", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = updateProgressSchema.parse(body);

  // Verify the track exists before insert. Without this, an unknown trackId
  // would surface as a Postgres FK-violation 500 — common in practice when
  // a client has stale local progress for tracks that were removed (or
  // came from a different DB seed). Returning 404 lets the client clean
  // up its local entry instead of retrying forever.
  const trackExists = await db.query.tracks.findFirst({
    where: eq(tracks.id, data.trackId),
    columns: { id: true },
  });
  if (!trackExists) {
    throw AppError.notFound(`Track ${data.trackId} not found`);
  }

  const completionPct = data.durationSeconds
    ? Math.min(100, Math.round((data.positionSeconds / data.durationSeconds) * 100))
    : 0;
  const isCompleted = completionPct >= 95;

  // Upsert progress
  const existing = await db.query.userProgress.findFirst({
    where: and(
      eq(userProgress.userId, user.id),
      eq(userProgress.trackId, data.trackId),
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(userProgress)
      .set({
        positionSeconds: data.positionSeconds,
        completionPct,
        isCompleted,
        playCount: existing.playCount + (isCompleted && !existing.isCompleted ? 1 : 0),
        totalListenSeconds: existing.totalListenSeconds + (data.positionSeconds - existing.positionSeconds),
        lastPlayed: new Date(),
        completedAt: isCompleted && !existing.isCompleted ? new Date() : existing.completedAt,
      })
      .where(eq(userProgress.id, existing.id))
      .returning();
    return c.json(updated!);
  }

  const [progress] = await db
    .insert(userProgress)
    .values({
      userId: user.id,
      trackId: data.trackId,
      positionSeconds: data.positionSeconds,
      completionPct,
      isCompleted,
      playCount: 1,
      totalListenSeconds: data.positionSeconds,
      lastPlayed: new Date(),
      completedAt: isCompleted ? new Date() : null,
    })
    .returning();

  return c.json(progress!, 201);
});

/**
 * GET /api/content/progress/:trackId - Get progress for a track
 */
contentRoutes.get("/progress/:trackId", async (c) => {
  const user = getUser(c);
  const trackId = parseInt(c.req.param("trackId"), 10);

  const progress = await db.query.userProgress.findFirst({
    where: and(
      eq(userProgress.userId, user.id),
      eq(userProgress.trackId, trackId),
    ),
  });

  if (!progress) {
    return c.json({ positionSeconds: 0, completionPct: 0, isCompleted: false });
  }

  return c.json(progress);
});

/**
 * GET /api/content/last-played - Get the user's most recently played track,
 * joined with track / session / event meta to populate IdleTrackInfo on a
 * fresh device. Returns null if the user has no progress rows yet.
 */
contentRoutes.get("/last-played", async (c) => {
  const user = getUser(c);

  const row = await db.query.userProgress.findFirst({
    where: eq(userProgress.userId, user.id),
    orderBy: (up, { desc }) => [desc(up.lastPlayed)],
    with: {
      track: {
        with: {
          session: {
            with: {
              event: true,
            },
          },
        },
      },
    },
  });

  if (!row) {
    return c.json(null);
  }

  return c.json({
    trackId: row.trackId,
    positionSeconds: row.positionSeconds,
    durationSeconds: null,
    isCompleted: row.isCompleted,
    lastPlayed: row.lastPlayed,
    track: row.track,
    session: row.track?.session ?? null,
    event: row.track?.session?.event ?? null,
  });
});

// --- Video Progress (session-scoped, cross-device) ---

const updateVideoProgressSchema = z.object({
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).optional(),
  completed: z.boolean().optional(),
});

/**
 * Resolve the session's parent event with audience info, then run the
 * standard checkEventAccess gate. Throws 403/404 as appropriate. Used by
 * both video-progress endpoints to make sure the user can actually access
 * this session's content before they get to read or write progress for it.
 */
async function authorizeVideoSessionAccess(c: any, sessionId: number) {
  const authUser = getUser(c);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: { event: { with: { audience: true } } },
  });
  if (!session) throw AppError.notFound("Session not found");
  if (!session.event) {
    // Orphaned session — fall through and trust auth, no audience to check.
    return { user: authUser, sessionRow: session };
  }
  // Build a UserForAccess shape from the DB user record (cached lookup).
  const fullUser = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
  if (!fullUser) throw AppError.unauthorized("User not found");
  const userForAccess = {
    id: fullUser.id,
    role: fullUser.role,
    subscriptionStatus: fullUser.subscriptionStatus,
    subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
  };
  const access = await checkEventAccess(userForAccess, session.event);
  if (!access.allowed) {
    if (access.reason === "AUTH_REQUIRED") throw AppError.unauthorized();
    throw AppError.forbidden("Access denied");
  }
  return { user: authUser, sessionRow: session };
}

/**
 * GET /api/content/video-progress/:sessionId — return the user's saved
 * watched-position for this session's video, or zero if none.
 */
contentRoutes.get("/video-progress/:sessionId", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const { user } = await authorizeVideoSessionAccess(c, sessionId);

  const progress = await db.query.videoProgress.findFirst({
    where: and(
      eq(videoProgress.userId, user.id),
      eq(videoProgress.sessionId, sessionId),
    ),
  });

  if (!progress) {
    return c.json({
      positionSeconds: 0,
      durationSeconds: null,
      completedAt: null,
      updatedAt: null,
    });
  }
  return c.json({
    positionSeconds: progress.positionSeconds,
    durationSeconds: progress.durationSeconds,
    completedAt: progress.completedAt,
    updatedAt: progress.updatedAt,
  });
});

/**
 * POST /api/content/video-progress/:sessionId — upsert the user's
 * watched-position. Last-write-wins by `updated_at`. Throttled by the
 * client to one save per ~5s.
 */
contentRoutes.post("/video-progress/:sessionId", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const { user } = await authorizeVideoSessionAccess(c, sessionId);
  const body = await c.req.json();
  const data = updateVideoProgressSchema.parse(body);

  const now = new Date();
  const completedAt = data.completed ? now : null;

  const existing = await db.query.videoProgress.findFirst({
    where: and(
      eq(videoProgress.userId, user.id),
      eq(videoProgress.sessionId, sessionId),
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(videoProgress)
      .set({
        positionSeconds: data.positionSeconds,
        durationSeconds: data.durationSeconds ?? existing.durationSeconds,
        // Preserve the original completedAt timestamp if already completed.
        completedAt: existing.completedAt ?? completedAt,
        updatedAt: now,
      })
      .where(eq(videoProgress.id, existing.id))
      .returning();
    return c.json(updated!);
  }

  const [created] = await db
    .insert(videoProgress)
    .values({
      userId: user.id,
      sessionId,
      positionSeconds: data.positionSeconds,
      durationSeconds: data.durationSeconds ?? null,
      completedAt,
    })
    .returning();
  return c.json(created!, 201);
});

// --- Bookmarks ---

contentRoutes.get("/bookmarks", async (c) => {
  const user = getUser(c);
  const data = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: { track: true },
  });
  return c.json(data);
});

contentRoutes.post("/bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createBookmarkSchema.parse(body);

  const [bookmark] = await db
    .insert(bookmarks)
    .values({ ...data, userId: user.id })
    .returning();

  return c.json(bookmark!, 201);
});

contentRoutes.delete("/bookmarks/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);

  const [bookmark] = await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, user.id)))
    .returning();

  if (!bookmark) throw AppError.notFound("Bookmark not found");
  return c.json(bookmark);
});

// --- Event Bookmarks ---
//
// Whole-event bookmarks (no track / no position). These coexist with the
// track-position `bookmarks` table above — they answer different questions:
// "save this event" vs. "remember this moment in this track".

const eventBookmarkWith = {
  event: {
    with: {
      eventType: true,
      audience: true,
      eventTeachers: { with: { teacher: true } },
      eventRetreatGroups: { with: { retreatGroup: true } },
      eventPlaces: { with: { place: true } },
    },
  },
} as const;

contentRoutes.get("/event-bookmarks", async (c) => {
  const user = getUser(c);
  const rows = await db.query.eventBookmarks.findMany({
    where: eq(eventBookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: eventBookmarkWith,
  });

  // Enrich teacher/group avatars with presigned URLs so the bookmarks tab
  // can render the same event card the events list uses.
  const events = rows.map((r) => r.event).filter(Boolean) as any[];
  await resolveEventsTeacherUrls(events);
  await resolveEventsGroupUrls(events);

  return c.json(rows);
});

contentRoutes.post("/event-bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createEventBookmarkSchema.parse(body);

  // Idempotent: re-bookmarking the same event returns the existing row.
  const [row] = await db
    .insert(eventBookmarks)
    .values({ userId: user.id, eventId: data.eventId })
    .onConflictDoNothing({ target: [eventBookmarks.userId, eventBookmarks.eventId] })
    .returning();

  const existing = row
    ? await db.query.eventBookmarks.findFirst({
        where: eq(eventBookmarks.id, row.id),
        with: eventBookmarkWith,
      })
    : await db.query.eventBookmarks.findFirst({
        where: and(
          eq(eventBookmarks.userId, user.id),
          eq(eventBookmarks.eventId, data.eventId),
        ),
        with: eventBookmarkWith,
      });

  if (!existing) throw AppError.notFound("Event not found");

  if (existing.event) {
    await resolveEventTeacherUrls(existing.event as any);
    await resolveEventGroupUrls(existing.event as any);
  }

  return c.json(existing, row ? 201 : 200);
});

contentRoutes.delete("/event-bookmarks/:eventId", async (c) => {
  const user = getUser(c);
  const eventId = parseInt(c.req.param("eventId"), 10);

  const [deleted] = await db
    .delete(eventBookmarks)
    .where(
      and(eq(eventBookmarks.userId, user.id), eq(eventBookmarks.eventId, eventId)),
    )
    .returning();

  if (!deleted) throw AppError.notFound("Bookmark not found");
  return c.json(deleted);
});

// --- Track Bookmarks ---
//
// Whole-track bookmarks (no position). Listed alongside event bookmarks on
// the Bookmarks tab. The track include carries session+event so the UI can
// show the bookmarked track in context and navigate back to its parent.

const trackBookmarkWith = {
  track: {
    with: {
      session: {
        with: {
          event: {
            with: {
              eventTeachers: { with: { teacher: true } },
              eventRetreatGroups: { with: { retreatGroup: true } },
            },
          },
        },
      },
    },
  },
} as const;

contentRoutes.get("/track-bookmarks", async (c) => {
  const user = getUser(c);
  const rows = await db.query.trackBookmarks.findMany({
    where: eq(trackBookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: trackBookmarkWith,
  });

  // Enrich teacher avatars on the embedded events so cards in the bookmarks
  // list look the same as elsewhere.
  const events = rows
    .map((r) => (r.track as any)?.session?.event)
    .filter(Boolean);
  await resolveEventsTeacherUrls(events);
  await resolveEventsGroupUrls(events);

  return c.json(rows);
});

contentRoutes.post("/track-bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createTrackBookmarkSchema.parse(body);

  const [row] = await db
    .insert(trackBookmarks)
    .values({ userId: user.id, trackId: data.trackId })
    .onConflictDoNothing({ target: [trackBookmarks.userId, trackBookmarks.trackId] })
    .returning();

  const existing = row
    ? await db.query.trackBookmarks.findFirst({
        where: eq(trackBookmarks.id, row.id),
        with: trackBookmarkWith,
      })
    : await db.query.trackBookmarks.findFirst({
        where: and(
          eq(trackBookmarks.userId, user.id),
          eq(trackBookmarks.trackId, data.trackId),
        ),
        with: trackBookmarkWith,
      });

  if (!existing) throw AppError.notFound("Track not found");

  const event = (existing.track as any)?.session?.event;
  if (event) {
    await resolveEventTeacherUrls(event);
    await resolveEventGroupUrls(event);
  }

  return c.json(existing, row ? 201 : 200);
});

contentRoutes.delete("/track-bookmarks/:trackId", async (c) => {
  const user = getUser(c);
  const trackId = parseInt(c.req.param("trackId"), 10);

  const [deleted] = await db
    .delete(trackBookmarks)
    .where(
      and(eq(trackBookmarks.userId, user.id), eq(trackBookmarks.trackId, trackId)),
    )
    .returning();

  if (!deleted) throw AppError.notFound("Bookmark not found");
  return c.json(deleted);
});

export { contentRoutes };
