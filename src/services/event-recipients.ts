import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events, eventRetreatGroups } from "../db/schema/retreats.ts";
import { users, userEventAttendance, userGroupMemberships } from "../db/schema/users.ts";
import { eventAccessGrants } from "../db/schema/event-access.ts";
import { config } from "../config.ts";
import { AUDIENCE_SLUGS, hasActiveSubscription, isPaidAudience } from "./access.ts";

export interface Recipient {
  id: number;
  email: string;
  firstName: string | null;
  preferredLanguage: string;
}

/**
 * The people who can open the event once it is published, for the "now available" email.
 *
 * This mirrors the rules of `checkEventAccess` in access.ts (keep them in step; a test
 * checks that every recipient passes it), evaluated for all users at once from a handful
 * of queries instead of one access check per user. Only active accounts are kept, and
 * never the store-review demo account.
 * Admins are treated like any other user (their own access does not add them).
 */
export async function listEventRecipients(eventId: number): Promise<Recipient[]> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: { audience: true },
  });
  if (!event) return [];

  const slug = event.audience?.slug;

  const [allUsers, grantRows, attendeeRows, groupRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        preferredLanguage: users.preferredLanguage,
        isActive: users.isActive,
        role: users.role,
        subscriptionStatus: users.subscriptionStatus,
        subscriptionExpiresAt: users.subscriptionExpiresAt,
      })
      .from(users)
      .where(eq(users.isActive, true)),
    db
      .select({ userId: eventAccessGrants.userId })
      .from(eventAccessGrants)
      .where(eq(eventAccessGrants.eventId, eventId)),
    db
      .select({ userId: userEventAttendance.userId })
      .from(userEventAttendance)
      .where(eq(userEventAttendance.eventId, eventId)),
    db
      .select({ retreatGroupId: eventRetreatGroups.retreatGroupId })
      .from(eventRetreatGroups)
      .where(eq(eventRetreatGroups.eventId, eventId)),
  ]);

  const groupIds = groupRows.map((g) => g.retreatGroupId);
  const memberRows =
    groupIds.length > 0
      ? await db
          .select({ userId: userGroupMemberships.userId })
          .from(userGroupMemberships)
          .where(inArray(userGroupMemberships.retreatGroupId, groupIds))
      : [];

  const granted = new Set(grantRows.map((r) => r.userId));
  const attended = new Set(attendeeRows.map((r) => r.userId));
  const members = new Set(memberRows.map((r) => r.userId));
  const noGroupLinked = groupIds.length === 0;

  // Same rule as checkGroupRule in access.ts
  const passesGroupRule = (userId: number) =>
    attended.has(userId) || noGroupLinked || members.has(userId);

  const reviewEmail = config.review.email;
  const paid = isPaidAudience(slug);

  const opens = (u: (typeof allUsers)[number]): boolean => {
    if (granted.has(u.id)) return true;
    const active = hasActiveSubscription(u);
    if (event.includedInMembership && !paid && active) return true;

    switch (slug) {
      case AUDIENCE_SLUGS.PUBLIC:
      case AUDIENCE_SLUGS.ACCOUNT_HOLDERS:
        return true;
      case AUDIENCE_SLUGS.ON_REQUEST:
      case AUDIENCE_SLUGS.INITIATION:
      case AUDIENCE_SLUGS.RESTRICTED:
        // Admin-granted attendance opens these; membership is not required
        return attended.has(u.id);
      case AUDIENCE_SLUGS.EVENT_PARTICIPANTS_ANY:
        return attended.has(u.id);
      case AUDIENCE_SLUGS.GROUP_MEMBERS_ANY:
        return passesGroupRule(u.id);
      case AUDIENCE_SLUGS.SUBSCRIBERS:
        return active;
      case AUDIENCE_SLUGS.GROUP_MEMBERS:
        return active && passesGroupRule(u.id);
      case AUDIENCE_SLUGS.EVENT_PARTICIPANTS:
        return active && attended.has(u.id);
      default:
        // Paid audiences, custom audiences, no audience: only a grant or the
        // membership inclusion above open them
        return false;
    }
  };

  const seen = new Set<number>();
  const recipients: Recipient[] = [];
  for (const u of allUsers) {
    if (seen.has(u.id)) continue;
    if (!u.isActive) continue;
    if (u.email.toLowerCase().trim() === reviewEmail) continue;
    if (!opens(u)) continue;
    seen.add(u.id);
    recipients.push({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      preferredLanguage: u.preferredLanguage,
    });
  }
  return recipients;
}
