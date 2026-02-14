import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { userGroupMemberships, userEventAttendance } from "../db/schema/users.ts";
import { eventRetreatGroups } from "../db/schema/retreats.ts";

// Audience slugs from seed-from-csv.ts (slugify of English names)
export const AUDIENCE_SLUGS = {
  PUBLIC: "free-anyone",
  SUBSCRIBERS: "free-subscribers",
  GROUP_MEMBERS: "retreat-group-members",
  EVENT_PARTICIPANTS: "event-participants",
  ON_REQUEST: "available-on-request-only",
  INITIATION: "received-initiation",
} as const;

export type AccessDeniedReason =
  | "SUBSCRIPTION_REQUIRED"
  | "GROUP_MEMBERSHIP_REQUIRED"
  | "EVENT_ATTENDANCE_REQUIRED"
  | "ACCESS_DENIED"
  | "AUTH_REQUIRED";

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: AccessDeniedReason };

interface UserForAccess {
  id: number;
  role: string;
  subscriptionStatus: string;
  subscriptionExpiresAt: Date | null;
}

interface EventForAccess {
  id: number;
  audience?: { slug: string } | null;
  audienceId?: number | null;
}

function hasActiveSubscription(user: UserForAccess): boolean {
  if (user.subscriptionStatus !== "active") return false;
  if (user.subscriptionExpiresAt && user.subscriptionExpiresAt < new Date()) return false;
  return true;
}

/**
 * Check if a user can access a specific event based on audience rules.
 *
 * Access model:
 * - Admin/superadmin: always allowed
 * - Public events: always allowed
 * - Subscriber events: active subscription
 * - Group member events: active subscription + user in event's group
 * - Event participant events: active subscription + user attended event
 * - On request / initiation: admin-granted via userEventAttendance (subscription optional)
 */
export async function checkEventAccess(
  user: UserForAccess | null,
  event: EventForAccess,
): Promise<AccessResult> {
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

  // Admin-granted access (on_request, initiation): check userEventAttendance
  // Subscription is NOT required — admin explicitly granted access
  if (
    audienceSlug === AUDIENCE_SLUGS.ON_REQUEST ||
    audienceSlug === AUDIENCE_SLUGS.INITIATION
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
): Promise<T[]> {
  const results = await Promise.all(
    eventList.map(async (event) => {
      const result = await checkEventAccess(user, event);
      return result.allowed ? event : null;
    }),
  );
  return results.filter((e): e is T => e !== null);
}
