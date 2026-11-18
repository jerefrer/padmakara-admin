import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.ts";
import { userProgress, bookmarks, eventBookmarks, trackBookmarks, videoBookmarks } from "../db/schema/user-content.ts";
import { videoProgress } from "../db/schema/video-progress.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { tracks } from "../db/schema/tracks.ts";
import { events } from "../db/schema/retreats.ts";
import {
  updateProgressSchema,
  createBookmarkSchema,
  createEventBookmarkSchema,
  createTrackBookmarkSchema,
  createVideoBookmarkSchema,
  updateVideoBookmarkSchema,
} from "../lib/schemas.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { checkEventAccess, eventStatusOpenTo, filterAccessibleEvents, type AccessCheckOptions } from "../services/access.ts";
import {
  applyContentVisibility,
  applyTrackReadAlongVisibility,
  assertAudioVisible,
  assertVideoVisible,
  mediaVisibleTo,
} from "../services/media-visibility.ts";
import { users } from "../db/schema/users.ts";
import { resolveEventTeacherUrls, resolveEventsTeacherUrls } from "../lib/teacher-utils.ts";
import { applyEventOrganizers, applyEventsOrganizers, eventOrganizersWith } from "../lib/organizer-utils.ts";
import { resolveEventGroupUrls, resolveEventsGroupUrls } from "../lib/group-utils.ts";
import { resolveEventImageUrls, resolveEventsImageUrls } from "../lib/event-image.ts";
import { TRACK_CLIENT_COLUMNS, VIDEO_CLIENT_COLUMNS, toClientTrack } from "../lib/client-columns.ts";
import { z } from "zod";

const contentRoutes = new Hono();

contentRoutes.use("*", authMiddleware);

// --- Access to the event behind a row ---
//
// Progress and bookmarks belong to the user, but they point at an event's content and
// their responses carry the event's metadata and track rows. So the full event access
// rule (status AND audience, `checkEventAccess`) applies: a caller outside the audience
// can neither write a row nor read one back. Rows saved while the caller still had
// access (subscription lapsed, group removed) stay in the database and come back in
// the lists once access returns.

interface EventForRow {
  id: number;
  status: string;
  audience?: { slug: string } | null;
  audienceId?: number | null;
  includedInMembership?: boolean | null;
}

/** The caller as the access service needs it: the subscription state is not in the token. */
async function loadUserForAccess(userId: number) {
  const fullUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!fullUser) throw AppError.unauthorized("User not found");
  return {
    id: fullUser.id,
    role: fullUser.role,
    subscriptionStatus: fullUser.subscriptionStatus,
    subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
  };
}

/**
 * 404 (as if the item did not exist, like a draft) unless the caller may open the
 * event's content. Every denial is a 404 so a write never confirms that a restricted
 * event or track exists.
 */
async function assertEventOpen(
  { id: userId, role }: { id: number; role: string },
  event: EventForRow | null | undefined,
  notFoundMessage: string,
): Promise<void> {
  if (!event) throw AppError.notFound(notFoundMessage);
  // The status gate needs no user lookup: a draft or forthcoming event stops here.
  if (!eventStatusOpenTo(role).includes(event.status)) throw AppError.notFound(notFoundMessage);
  const access = await checkEventAccess(await loadUserForAccess(userId), event);
  if (!access.allowed) throw AppError.notFound(notFoundMessage);
}

/**
 * Ids of the events, among those behind a list of rows, that the caller may open.
 * `listing` judges them as the event list does (a forthcoming event is announced).
 */
async function openEventIds(
  userId: number,
  rowEvents: Array<EventForRow | null | undefined>,
  opts: AccessCheckOptions = {},
): Promise<Set<number>> {
  const unique = new Map<number, EventForRow>();
  for (const event of rowEvents) if (event) unique.set(event.id, event);
  if (unique.size === 0) return new Set();
  const open = await filterAccessibleEvents(await loadUserForAccess(userId), [...unique.values()], {
    listing: opts.listing,
  });
  return new Set(open.map((event) => event.id));
}

/** The audience is loaded for the access check only: drop it to keep the payload's shape. */
function dropAudience(event: unknown): void {
  if (event && typeof event === "object") delete (event as { audience?: unknown }).audience;
}

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
  // a client has stale local progress for tracks that were removed (or came
  // from a different DB seed). We respond with 200 + a `skipped` marker
  // (not 404) so browsers don't log a red error in DevTools every time a
  // legacy orphan tries to sync; the client still sees the marker and
  // cleans up its local entry so it stops retrying.
  //
  // We also load session→event here so we can check the event's access
  // below — draft events and events outside the caller's audience must be
  // invisible to them.
  const trackExists = await db.query.tracks.findFirst({
    where: eq(tracks.id, data.trackId),
    with: { session: { with: { event: { with: { audience: true } } } } },
  });
  if (!trackExists) {
    return c.json({ skipped: true, reason: "unknown_track", trackId: data.trackId });
  }

  // Access guard (content, not listing): callers must not be able to record
  // progress on tracks of a draft/forthcoming event (that would leak that the
  // event exists) nor of an event outside their audience. Treat it the same as
  // a missing track (`skipped` would be confusing for a draft — 404 is cleaner
  // and matches the GET behaviour).
  await assertEventOpen(user, trackExists.session?.event, "Track not found");
  // Same for a track whose audio is hidden (a regular user must not know it exists)
  assertAudioVisible(trackExists.session?.event, user.role, "Track not found");

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

  // A few of the latest rows, so a track whose audio is hidden is skipped
  // rather than hiding every older one behind it.
  const recent = await db.query.userProgress.findMany({
    where: eq(userProgress.userId, user.id),
    orderBy: (up, { desc }) => [desc(up.lastPlayed)],
    limit: 25,
    with: {
      track: {
        columns: TRACK_CLIENT_COLUMNS,
        with: {
          session: {
            with: {
              event: { with: { audience: true } },
            },
          },
        },
      },
    },
  });
  // A track of an event the caller can no longer open is skipped too.
  const openIds = await openEventIds(user.id, recent.map((r) => r.track?.session?.event));
  const row = recent.find((r) => {
    const event = r.track?.session?.event;
    return !!event && openIds.has(event.id) && mediaVisibleTo(event, user.role).audio;
  });

  if (!row) {
    return c.json(null);
  }

  // The embedded event carries the themes; the track carries the read-along
  applyTrackReadAlongVisibility(row.track, row.track?.session?.event, user.role);
  toClientTrack(row.track);
  applyContentVisibility(row.track?.session?.event, user.role);
  dropAudience(row.track?.session?.event);
  // The event photo as URLs, without its storage keys
  await resolveEventImageUrls(row.track?.session?.event);

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

// --- Video Progress (event-video-scoped, cross-device) ---

const updateVideoProgressSchema = z.object({
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).optional(),
  completed: z.boolean().optional(),
});

/**
 * Resolve the event_video's parent event with audience info, then run the
 * standard checkEventAccess gate. Throws 401/403/404 as appropriate. Used by
 * both video-progress endpoints to make sure the user can actually access
 * this video's content before they get to read or write progress for it.
 */
async function authorizeVideoAccess(c: any, videoId: number) {
  const authUser = getUser(c);
  const video = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
    with: { event: { with: { audience: true } } },
  });
  if (!video) throw AppError.notFound("Video not found");
  if (!video.event) {
    // Orphaned video — fall through and trust auth, no audience to check.
    return { user: authUser, video };
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
  const access = await checkEventAccess(userForAccess, video.event);
  if (!access.allowed) {
    if (access.reason === "AUTH_REQUIRED") throw AppError.unauthorized();
    throw AppError.forbidden("Access denied");
  }
  assertVideoVisible(video.event, authUser.role, "Video not found");
  return { user: authUser, video };
}

/**
 * GET /api/content/video-progress/:videoId — return the user's saved
 * watched-position for this event_video, or zero if none.
 */
contentRoutes.get("/video-progress/:videoId", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const { user } = await authorizeVideoAccess(c, videoId);

  const progress = await db.query.videoProgress.findFirst({
    where: and(
      eq(videoProgress.userId, user.id),
      eq(videoProgress.videoId, videoId),
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
 * POST /api/content/video-progress/:videoId — upsert the user's
 * watched-position. Last-write-wins by `updated_at`. Throttled by the
 * client to one save per ~5s.
 */
contentRoutes.post("/video-progress/:videoId", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const { user } = await authorizeVideoAccess(c, videoId);
  const body = await c.req.json();
  const data = updateVideoProgressSchema.parse(body);

  const now = new Date();
  const completedAt = data.completed ? now : null;

  const existing = await db.query.videoProgress.findFirst({
    where: and(
      eq(videoProgress.userId, user.id),
      eq(videoProgress.videoId, videoId),
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
      videoId,
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
  const rows = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: {
      track: {
        columns: TRACK_CLIENT_COLUMNS,
        with: { session: { with: { event: { with: { audience: true } } } } },
      },
    },
  });
  // Keep the payload shape (the bare track): the event is loaded only to apply the
  // access and audio visibility rules. Bookmarks on a track of an event the caller can
  // no longer open, or whose audio is hidden, stay saved but are not listed.
  const openIds = await openEventIds(user.id, rows.map((r) => r.track?.session?.event));
  const data = rows
    .filter((r) => {
      const event = r.track?.session?.event;
      return !!event && openIds.has(event.id) && mediaVisibleTo(event, user.role).audio;
    })
    .map(({ track, ...bookmark }) => {
      if (!track) return { ...bookmark, track };
      const { session: _session, ...bareTrack } = track;
      applyTrackReadAlongVisibility(bareTrack, _session?.event, user.role);
      toClientTrack(bareTrack);
      return { ...bookmark, track: bareTrack };
    });
  return c.json(data);
});

contentRoutes.post("/bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createBookmarkSchema.parse(body);

  // Same guard as progress: a missing track, a track of an event the caller may not
  // open, or one whose audio is hidden are all a 404.
  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, data.trackId),
    with: { session: { with: { event: { with: { audience: true } } } } },
  });
  await assertEventOpen(user, track?.session?.event, "Track not found");
  assertAudioVisible(track?.session?.event, user.role, "Track not found");

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
      eventOrganizers: eventOrganizersWith,
    },
  },
} as const;

contentRoutes.get("/event-bookmarks", async (c) => {
  const user = getUser(c);
  const allRows = await db.query.eventBookmarks.findMany({
    where: eq(eventBookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: eventBookmarkWith,
  });

  // Saved events the caller can no longer open stay saved but are not listed. Judged
  // as the event list does: a forthcoming event is announced, without its content.
  const openIds = await openEventIds(user.id, allRows.map((r) => r.event), { listing: true });
  const rows = allRows.filter((r) => r.event && openIds.has(r.event.id));

  // Enrich teacher/group avatars with presigned URLs so the bookmarks tab
  // can render the same event card the events list uses.
  const events = rows.map((r) => r.event).filter(Boolean) as any[];
  for (const event of events) applyContentVisibility(event, user.role);
  await resolveEventsTeacherUrls(events);
  await resolveEventsGroupUrls(events);
  await resolveEventsImageUrls(events);
  applyEventsOrganizers(events);

  return c.json(rows);
});

contentRoutes.post("/event-bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createEventBookmarkSchema.parse(body);

  // Access guard: verify the event exists and the caller may open it before
  // inserting. A non-admin must not be able to bookmark a draft event — doing so
  // would confirm the event's existence to the client — nor an event outside
  // their audience, whose metadata the read-back below would return.
  const event = await db.query.events.findFirst({
    where: eq(events.id, data.eventId),
    with: { audience: true },
  });
  await assertEventOpen(user, event, "Event not found");

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
    applyContentVisibility(existing.event, user.role);
    await resolveEventTeacherUrls(existing.event as any);
    await resolveEventGroupUrls(existing.event as any);
    await resolveEventImageUrls(existing.event as any);
    applyEventOrganizers(existing.event);
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
    columns: TRACK_CLIENT_COLUMNS,
    with: {
      session: {
        with: {
          event: {
            with: {
              audience: true,
              eventTeachers: { with: { teacher: true } },
              eventRetreatGroups: { with: { retreatGroup: true } },
              eventOrganizers: eventOrganizersWith,
            },
          },
        },
      },
    },
  },
} as const;

contentRoutes.get("/track-bookmarks", async (c) => {
  const user = getUser(c);
  const allRows = await db.query.trackBookmarks.findMany({
    where: eq(trackBookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: trackBookmarkWith,
  });

  // Bookmarks on a track of an event the caller can no longer open, or whose audio
  // is hidden, stay saved but are not listed.
  const openIds = await openEventIds(user.id, allRows.map((r) => r.track?.session?.event));
  const rows = allRows.filter((r) => {
    const event = r.track?.session?.event;
    return !!event && openIds.has(event.id) && mediaVisibleTo(event, user.role).audio;
  });

  // Enrich teacher avatars on the embedded events so cards in the bookmarks
  // list look the same as elsewhere.
  const events = rows
    .map((r) => (r.track as any)?.session?.event)
    .filter(Boolean);
  for (const row of rows) {
    const event = (row.track as any)?.session?.event;
    applyTrackReadAlongVisibility(row.track, event, user.role);
    toClientTrack(row.track);
    dropAudience(event);
  }
  for (const event of events) applyContentVisibility(event, user.role);
  await resolveEventsTeacherUrls(events);
  await resolveEventsGroupUrls(events);
  await resolveEventsImageUrls(events);
  applyEventsOrganizers(events);

  return c.json(rows);
});

contentRoutes.post("/track-bookmarks", async (c) => {
  const user = getUser(c);
  const body = await c.req.json();
  const data = createTrackBookmarkSchema.parse(body);

  // Access guard: load the track's parent event before inserting. The
  // `trackBookmarkWith` join already loads session→event on the read-back path,
  // but the check must happen BEFORE the insert so a caller cannot confirm a
  // draft or restricted event's existence via FK success/failure, nor get its
  // metadata back. A missing track, a draft-event track and a track outside the
  // caller's audience all return 404.
  const trackForGuard = await db.query.tracks.findFirst({
    where: eq(tracks.id, data.trackId),
    with: { session: { with: { event: { with: { audience: true } } } } },
  });
  await assertEventOpen(user, trackForGuard?.session?.event, "Track not found");
  assertAudioVisible(trackForGuard?.session?.event, user.role, "Track not found");

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
  applyTrackReadAlongVisibility(existing.track, event, user.role);
  toClientTrack(existing.track);
  if (event) {
    dropAudience(event);
    await resolveEventTeacherUrls(event);
    await resolveEventGroupUrls(event);
    await resolveEventImageUrls(event);
    applyEventOrganizers(event);
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

// --- Video Bookmarks ---
//
// Position bookmarks inside an event video (several per video, optional
// note). Listed on the Bookmarks tab; the video include carries the event so
// the UI can show it in context and navigate back to the video.

const videoBookmarkWith = {
  video: {
    columns: VIDEO_CLIENT_COLUMNS,
    with: {
      event: {
        with: {
          audience: true,
          eventTeachers: { with: { teacher: true } },
          eventRetreatGroups: { with: { retreatGroup: true } },
          eventOrganizers: eventOrganizersWith,
        },
      },
    },
  },
} as const;

async function enrichVideoBookmarkEvents(
  rows: Array<{ video?: unknown }>,
  role: string | null | undefined,
) {
  const evts = rows
    .map((r) => (r.video as any)?.event)
    .filter(Boolean);
  for (const event of evts) {
    applyContentVisibility(event, role);
    dropAudience(event);
  }
  await resolveEventsTeacherUrls(evts);
  await resolveEventsGroupUrls(evts);
  await resolveEventsImageUrls(evts);
  applyEventsOrganizers(evts);
}

contentRoutes.get("/video-bookmarks", async (c) => {
  const user = getUser(c);
  const allRows = await db.query.videoBookmarks.findMany({
    where: eq(videoBookmarks.userId, user.id),
    orderBy: (b, { desc }) => [desc(b.createdAt)],
    with: videoBookmarkWith,
  });
  // Bookmarks on a video of an event the caller can no longer open, or whose video
  // is hidden, stay saved but are not listed.
  const openIds = await openEventIds(user.id, allRows.map((r) => r.video?.event));
  const rows = allRows.filter((r) => {
    const event = r.video?.event;
    return !!event && openIds.has(event.id) && mediaVisibleTo(event, user.role).video;
  });
  await enrichVideoBookmarkEvents(rows, user.role);
  return c.json(rows);
});

contentRoutes.post("/video-bookmarks", async (c) => {
  const body = await c.req.json();
  const data = createVideoBookmarkSchema.parse(body);

  // Same gate as video progress: the event must be visible to the caller
  // (draft guard) and the caller must be allowed into it (audience).
  const { user } = await authorizeVideoAccess(c, data.videoId);

  // A client-supplied timestamp is only used to keep the original date of a
  // bookmark synced from the device; never accept a future date.
  const now = new Date();
  const sent = data.createdAt ? new Date(data.createdAt) : null;
  const createdAt = sent && sent <= now ? sent : now;

  const [row] = await db
    .insert(videoBookmarks)
    .values({
      userId: user.id,
      videoId: data.videoId,
      positionSeconds: data.positionSeconds,
      note: data.note || null,
      createdAt,
    })
    .returning();

  const created = await db.query.videoBookmarks.findFirst({
    where: eq(videoBookmarks.id, row!.id),
    with: videoBookmarkWith,
  });
  if (!created) throw AppError.notFound("Bookmark not found");
  await enrichVideoBookmarkEvents([created], user.role);

  return c.json(created, 201);
});

contentRoutes.patch("/video-bookmarks/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);
  const data = updateVideoBookmarkSchema.parse(await c.req.json());

  const [updated] = await db
    .update(videoBookmarks)
    .set({ note: data.note || null })
    .where(and(eq(videoBookmarks.id, id), eq(videoBookmarks.userId, user.id)))
    .returning();

  if (!updated) throw AppError.notFound("Bookmark not found");
  return c.json(updated);
});

contentRoutes.delete("/video-bookmarks/:id", async (c) => {
  const user = getUser(c);
  const id = parseInt(c.req.param("id"), 10);

  const [deleted] = await db
    .delete(videoBookmarks)
    .where(and(eq(videoBookmarks.id, id), eq(videoBookmarks.userId, user.id)))
    .returning();

  if (!deleted) throw AppError.notFound("Bookmark not found");
  return c.json(deleted);
});

export { contentRoutes };
