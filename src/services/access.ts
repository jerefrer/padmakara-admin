import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, userGroupMemberships, userEventAttendance } from "../db/schema/users.ts";
import { eventRetreatGroups } from "../db/schema/retreats.ts";
import { eventAccessGrants } from "../db/schema/event-access.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";

// Audience slugs from seed-from-csv.ts (slugify of English names)
export const AUDIENCE_SLUGS = {
  PUBLIC: "free-anyone",
  SUBSCRIBERS: "free-subscribers",
  GROUP_MEMBERS: "retreat-group-members",
  EVENT_PARTICIPANTS: "event-participants",
  ON_REQUEST: "available-on-request-only",
  INITIATION: "received-initiation",
  // Hidden in the app unless an admin grants access; added for publications,
  // and handled for events exactly like ON_REQUEST.
  RESTRICTED: "restricted",
  // Sold per teaching to anyone / to members only (members pay too). Opened by a
  // per-event grant or the admin role alone, never by the audience itself.
  PAID_ALL: "everyone-paid",
  PAID_MEMBERS: "member-extra-subscription",
} as const;

/** Whether the audience slug is one of the paid-per-teaching audiences. */
export function isPaidAudience(slug: string | null | undefined): boolean {
  return slug === AUDIENCE_SLUGS.PAID_ALL || slug === AUDIENCE_SLUGS.PAID_MEMBERS;
}

export type AccessDeniedReason =
  | "STATUS_HIDDEN"
  | "SUBSCRIPTION_REQUIRED"
  | "GROUP_MEMBERSHIP_REQUIRED"
  | "EVENT_ATTENDANCE_REQUIRED"
  | "ACCESS_DENIED"
  | "AUTH_REQUIRED";

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: AccessDeniedReason };

/**
 * Translate an access-denied reason into the matching HTTP error and throw it.
 * Shared by every route that gates on `checkEventAccess` so the reason→status
 * mapping lives in exactly one place.
 *
 * - STATUS_HIDDEN → 404: a draft/archived event must be indistinguishable from
 *   a non-existent one for callers who cannot see that status.
 * - AUTH_REQUIRED → 401.
 * - All audience denials → 403, with a reason-specific message.
 */
export function denialToHttpError(reason: AccessDeniedReason): never {
  switch (reason) {
    case "STATUS_HIDDEN":
      throw AppError.notFound("Event not found");
    case "AUTH_REQUIRED":
      throw new AppError(401, "Authentication required", "AUTH_REQUIRED");
    case "SUBSCRIPTION_REQUIRED":
      throw new AppError(403, "Active subscription required", "SUBSCRIPTION_REQUIRED");
    case "GROUP_MEMBERSHIP_REQUIRED":
      throw new AppError(403, "Group membership required", "GROUP_MEMBERSHIP_REQUIRED");
    case "EVENT_ATTENDANCE_REQUIRED":
      throw new AppError(403, "Event attendance required", "EVENT_ATTENDANCE_REQUIRED");
    default:
      throw new AppError(403, "Access denied", "ACCESS_DENIED");
  }
}

interface UserForAccess {
  id: number;
  role: string;
  subscriptionStatus: string;
  subscriptionExpiresAt: Date | null;
}

interface EventForAccess {
  id: number;
  status: string;
  audience?: { slug: string } | null;
  audienceId?: number | null;
  /** Teaching included in the membership: active members get it whatever the audience. */
  includedInMembership?: boolean | null;
}

/**
 * Whether the user's contribution currently entitles them to member content.
 *
 * `subscriptionExpiresAt` is the date they have paid through. We keep access open for
 * `config.subscription.graceDays` beyond it, because a renewal notification can arrive
 * late or not at all — Easypay does not guarantee delivery, and a member who has been
 * charged must not lose access while we wait to hear about it. A few extra days of
 * access costs nothing; locking out someone who paid costs trust.
 *
 * A cancelled subscription is still active until its paid-through date, so
 * `subscriptionCancelledAt` deliberately plays no part here.
 */
export function hasActiveSubscription(user: {
  subscriptionStatus: string;
  subscriptionExpiresAt: Date | null;
}): boolean {
  if (user.subscriptionStatus !== "active") return false;
  if (!user.subscriptionExpiresAt) return true;
  const cutoff = new Date(user.subscriptionExpiresAt);
  cutoff.setDate(cutoff.getDate() + config.subscription.graceDays);
  return cutoff >= new Date();
}

/**
 * Event statuses a caller of the given role may see in the app.
 * Admins/superadmins see drafts; everyone else (incl. unauthenticated) sees
 * only published. `archived` is never visible in the app.
 */
export function eventStatusVisibleTo(role: string | null | undefined): string[] {
  return role === "admin" || role === "superadmin"
    ? ["published", "draft"]
    : ["published"];
}

/**
 * Whether the user is allowed to see content marked as "subscribers" only.
 * True for admins/superadmins and for users with an active, non-expired subscription.
 * False for unauthenticated users.
 */
export async function canUserSeeSubscriberContent(
  user: { id: number; role: string } | null,
): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin" || user.role === "superadmin") return true;
  const [dbUser] = await db
    .select({
      subscriptionStatus: users.subscriptionStatus,
      subscriptionExpiresAt: users.subscriptionExpiresAt,
    })
    .from(users)
    .where(eq(users.id, user.id));
  return dbUser ? hasActiveSubscription(dbUser) : false;
}

/** Whether the user holds an access grant (purchase, free claim or manual) on the event. */
export async function hasEventGrant(userId: number, eventId: number): Promise<boolean> {
  const grant = await db.query.eventAccessGrants.findFirst({
    where: and(
      eq(eventAccessGrants.userId, userId),
      eq(eventAccessGrants.eventId, eventId),
    ),
  });
  return !!grant;
}

/**
 * Check if a user can access a specific event based on audience rules.
 *
 * Access model:
 * - Admin/superadmin: always allowed
 * - Included in the membership (per event flag) + active subscription: allowed
 *   whatever the audience, no grant row (status gate still applies first)
 * - Per-event access grant: allowed whatever the audience and subscription
 *   (only once the status gate has passed, so a granted draft stays hidden)
 * - Paid audiences (everyone-paid, member-extra-subscription): grant or admin only;
 *   membership inclusion does not apply
 * - Public events: always allowed
 * - Subscriber events: active subscription
 * - Group member events: active subscription + user in event's group
 * - Event participant events: active subscription + user attended event
 * - On request / initiation / restricted: admin-granted via userEventAttendance (subscription optional)
 */
export async function checkEventAccess(
  user: UserForAccess | null,
  event: EventForAccess,
): Promise<AccessResult> {
  return checkEventAccessWith(user, event, (u) => hasEventGrant(u.id, event.id));
}

/**
 * The audience rule alone: no per-event grant and no membership inclusion. For derived
 * views that must not widen because someone bought or was included in one event (the
 * groups card, legacy publication access, which only ever followed the audience).
 */
export async function checkEventAccessAudienceOnly(
  user: UserForAccess | null,
  event: EventForAccess,
): Promise<AccessResult> {
  return checkEventAccessWith(user, { ...event, includedInMembership: false }, async () => false);
}

async function checkEventAccessWith(
  user: UserForAccess | null,
  event: EventForAccess,
  hasGrant: (user: UserForAccess) => Promise<boolean>,
): Promise<AccessResult> {
  // Status gate: runs before all other checks, including admin bypass.
  // archived is hidden from everyone; draft is hidden from non-admins.
  if (!eventStatusVisibleTo(user?.role).includes(event.status)) {
    return { allowed: false, reason: "STATUS_HIDDEN" };
  }

  const audienceSlug = event.audience?.slug;

  // Public events: anyone can access, no auth needed
  if (audienceSlug === AUDIENCE_SLUGS.PUBLIC) {
    return { allowed: true };
  }

  // All non-public events require authentication
  if (!user) {
    return { allowed: false, reason: "AUTH_REQUIRED" };
  }

  // Admin/superadmin bypass all checks
  if (user.role === "admin" || user.role === "superadmin") {
    return { allowed: true };
  }

  // Included in the membership: active members get it whatever the audience.
  // Pure check on data already loaded, so it costs no query (also in filterAccessibleEvents).
  // Paid audiences are the exception: members pay for those too.
  if (event.includedInMembership && !isPaidAudience(audienceSlug) && hasActiveSubscription(user)) {
    return { allowed: true };
  }

  // Per-event grant: wins over audience rules and subscription state
  if (await hasGrant(user)) {
    return { allowed: true };
  }

  // Paid audiences: only a grant (checked above) or the admin role opens them.
  if (isPaidAudience(audienceSlug)) {
    return { allowed: false, reason: "ACCESS_DENIED" };
  }

  // Admin-granted access (on_request, initiation): check userEventAttendance
  // Subscription is NOT required — admin explicitly granted access
  if (
    audienceSlug === AUDIENCE_SLUGS.ON_REQUEST ||
    audienceSlug === AUDIENCE_SLUGS.INITIATION ||
    audienceSlug === AUDIENCE_SLUGS.RESTRICTED
  ) {
    const attendance = await db.query.userEventAttendance.findFirst({
      where: and(
        eq(userEventAttendance.userId, user.id),
        eq(userEventAttendance.eventId, event.id),
      ),
    });
    if (attendance) return { allowed: true };
    return { allowed: false, reason: "ACCESS_DENIED" };
  }

  // All remaining audience types require active subscription
  if (!hasActiveSubscription(user)) {
    return { allowed: false, reason: "SUBSCRIPTION_REQUIRED" };
  }

  // Subscriber events: subscription alone is sufficient
  if (audienceSlug === AUDIENCE_SLUGS.SUBSCRIBERS) {
    return { allowed: true };
  }

  // Group member events: subscription + (user in event's retreat group OR attended this event)
  // Event attendance takes precedence — members who attended events in other groups
  // should have access to those recordings even without formal group membership.
  if (audienceSlug === AUDIENCE_SLUGS.GROUP_MEMBERS) {
    // Check event attendance first (covers cross-group participants)
    const attendance = await db.query.userEventAttendance.findFirst({
      where: and(
        eq(userEventAttendance.userId, user.id),
        eq(userEventAttendance.eventId, event.id),
      ),
    });
    if (attendance) return { allowed: true };

    const eventGroups = await db
      .select({ retreatGroupId: eventRetreatGroups.retreatGroupId })
      .from(eventRetreatGroups)
      .where(eq(eventRetreatGroups.eventId, event.id));

    if (eventGroups.length === 0) return { allowed: true }; // No groups linked = open to subscribers

    const eventGroupIds = eventGroups.map((g) => g.retreatGroupId);
    const membership = await db.query.userGroupMemberships.findFirst({
      where: and(
        eq(userGroupMemberships.userId, user.id),
        inArray(userGroupMemberships.retreatGroupId, eventGroupIds),
      ),
    });

    if (membership) return { allowed: true };
    return { allowed: false, reason: "GROUP_MEMBERSHIP_REQUIRED" };
  }

  // Event participant events: subscription + user attended this event
  if (audienceSlug === AUDIENCE_SLUGS.EVENT_PARTICIPANTS) {
    const attendance = await db.query.userEventAttendance.findFirst({
      where: and(
        eq(userEventAttendance.userId, user.id),
        eq(userEventAttendance.eventId, event.id),
      ),
    });
    if (attendance) return { allowed: true };
    return { allowed: false, reason: "EVENT_ATTENDANCE_REQUIRED" };
  }

  // Unknown audience type or no audience set: deny by default
  return { allowed: false, reason: "ACCESS_DENIED" };
}

/**
 * Check which events from a list the user can access.
 * Returns the subset of events the user is allowed to see.
 */
export async function filterAccessibleEvents<T extends EventForAccess>(
  user: UserForAccess | null,
  eventList: T[],
  opts: { audienceOnly?: boolean } = {},
): Promise<T[]> {
  if (opts.audienceOnly) {
    const kept: (T | null)[] = await Promise.all(
      eventList.map(async (event) => ((await checkEventAccessAudienceOnly(user, event)).allowed ? event : null)),
    );
    return kept.filter((e): e is T => e !== null);
  }

  // Load the user's granted event ids once instead of once per event.
  let granted: Set<number> | null = null;
  if (user && user.role !== "admin" && user.role !== "superadmin" && eventList.length > 0) {
    const rows = await db
      .select({ eventId: eventAccessGrants.eventId })
      .from(eventAccessGrants)
      .where(eq(eventAccessGrants.userId, user.id));
    granted = new Set(rows.map((r) => r.eventId));
  }
  const grantedIds = granted ?? new Set<number>();

  const results: (T | null)[] = await Promise.all(
    eventList.map(async (event) => {
      const result = await checkEventAccessWith(user, event, async () =>
        grantedIds.has(event.id),
      );
      return result.allowed ? event : null;
    }),
  );
  // Explicit (T | null)[] annotation prevents TypeScript from widening T to Awaited<T>
  return results.filter((e): e is T => e !== null);
}
