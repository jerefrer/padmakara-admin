import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { audiences } from "../db/schema/audiences.ts";
import {
  eventPublications,
  publicationAccessUsers,
  publicationRetreatGroups,
} from "../db/schema/publications.ts";
import { eventRetreatGroups } from "../db/schema/retreats.ts";
import { users, userEventAttendance, userGroupMemberships } from "../db/schema/users.ts";
import { AUDIENCE_SLUGS, checkEventAccess, hasActiveSubscription } from "./access.ts";

/**
 * Who may open a publication.
 *
 * Shown in the app:
 * - public: anyone, signed in or not.
 * - subscribers: members.
 * - retreat group members: members belonging to at least one of the retreat
 *   groups ticked on the publication (the rule events use for their groups).
 * - event participants: members who attended an event of one of the ticked
 *   groups.
 *
 * Hidden in the app unless access is given (received initiation, available on
 * request only, restricted): nobody, except the users on the publication's
 * access list. No subscription is needed; the admin granted it.
 *
 * Admins open everything with a known audience. An audience that is missing or
 * not recognised is refused for everyone: a restricted text must never fall
 * open because of a value nobody handled.
 *
 * Legacy: before groups and the access list existed, the linked events decided
 * (`checkEventAccess` per event, same audience). A publication with an
 * event-based audience that has no ticked groups (group / participants) or an
 * empty access list (received initiation, on request) keeps that rule until an
 * admin classifies it. `restricted` has no legacy.
 */
// Read lazily: modules that mock access.ts partially must still be able to import this one.
const knownAudiences = (): string[] => [
  AUDIENCE_SLUGS.PUBLIC,
  AUDIENCE_SLUGS.SUBSCRIBERS,
  AUDIENCE_SLUGS.EVENT_PARTICIPANTS,
  AUDIENCE_SLUGS.GROUP_MEMBERS,
  AUDIENCE_SLUGS.INITIATION,
  AUDIENCE_SLUGS.ON_REQUEST,
  AUDIENCE_SLUGS.RESTRICTED,
];

/** Audiences whose publications only the access list opens. */
export const isHiddenAudience = (slug: string): boolean =>
  slug === AUDIENCE_SLUGS.INITIATION ||
  slug === AUDIENCE_SLUGS.ON_REQUEST ||
  slug === AUDIENCE_SLUGS.RESTRICTED;

/** Audience id -> slug, for deciding on rows that only carry the id. */
export async function publicationAudienceSlugs(): Promise<Map<number, string>> {
  const rows = await db.select().from(audiences);
  return new Map(rows.map((a) => [a.id, a.slug]));
}

/** Whether a publication with this audience is made for members alone. */
export function isMemberOnlyAudience(slug: string | null | undefined): boolean {
  return slug === AUDIENCE_SLUGS.SUBSCRIBERS;
}

/** Group a list of (publication, value) rows by publication. */
function indexByPublication<T extends { publicationId: number }>(
  rows: T[],
  value: (row: T) => number,
): Map<number, Set<number>> {
  const index = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = index.get(row.publicationId) ?? new Set<number>();
    set.add(value(row));
    index.set(row.publicationId, set);
  }
  return index;
}

/**
 * The publications, among `pubs`, that the caller can open. One decision for
 * every route (list, PDF, event page).
 *
 * `pubs` carry the id of their audience row; slugs are looked up here.
 */
export async function openablePublications(
  authUser: { id: number; role: string } | null,
  pubs: { id: number; audienceId: number | null }[],
): Promise<Set<number>> {
  const opened = new Set<number>();
  if (pubs.length === 0) return opened;

  const slugById = await publicationAudienceSlugs();
  const slugOf = (p: { audienceId: number | null }) =>
    p.audienceId === null ? undefined : slugById.get(p.audienceId);

  const isAdmin = authUser?.role === "admin" || authUser?.role === "superadmin";
  // checkEventAccess needs the subscription state, which the token lacks.
  const user = authUser
    ? ((await db.query.users.findFirst({ where: eq(users.id, authUser.id) })) ?? null)
    : null;

  const classified: { id: number; slug: string }[] = [];
  for (const pub of pubs) {
    const slug = slugOf(pub);
    if (!slug || !knownAudiences().includes(slug)) continue;
    if (slug === AUDIENCE_SLUGS.PUBLIC) {
      opened.add(pub.id);
    } else if (isAdmin) {
      opened.add(pub.id);
    } else if (slug === AUDIENCE_SLUGS.SUBSCRIBERS) {
      if (user && hasActiveSubscription(user)) opened.add(pub.id);
    } else if (user) {
      classified.push({ id: pub.id, slug });
    }
  }
  if (classified.length === 0 || !user) return opened;

  const ids = classified.map((p) => p.id);
  const [groupRows, accessRows] = await Promise.all([
    db
      .select({
        publicationId: publicationRetreatGroups.publicationId,
        retreatGroupId: publicationRetreatGroups.retreatGroupId,
      })
      .from(publicationRetreatGroups)
      .where(inArray(publicationRetreatGroups.publicationId, ids)),
    db
      .select({
        publicationId: publicationAccessUsers.publicationId,
        userId: publicationAccessUsers.userId,
      })
      .from(publicationAccessUsers)
      .where(inArray(publicationAccessUsers.publicationId, ids)),
  ]);
  const groupsByPub = indexByPublication(groupRows, (r) => r.retreatGroupId);
  const listByPub = indexByPublication(accessRows, (r) => r.userId);

  // Loaded once, only when some publication needs them.
  let memberGroups: Promise<Set<number>> | undefined;
  const userGroupIds = () =>
    (memberGroups ??= db
      .select({ retreatGroupId: userGroupMemberships.retreatGroupId })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.userId, user.id))
      .then((rows) => new Set(rows.map((r) => r.retreatGroupId))));
  let attendedGroups: Promise<Set<number>> | undefined;
  const attendedGroupIds = () =>
    (attendedGroups ??= db
      .select({ retreatGroupId: eventRetreatGroups.retreatGroupId })
      .from(userEventAttendance)
      .innerJoin(eventRetreatGroups, eq(eventRetreatGroups.eventId, userEventAttendance.eventId))
      .where(eq(userEventAttendance.userId, user.id))
      .then((rows) => new Set(rows.map((r) => r.retreatGroupId))));

  // Classified in the new model they are decided here; the others are legacy
  // and fall back to their linked events below.
  const legacy: { id: number; slug: string }[] = [];
  for (const pub of classified) {
    const groups = groupsByPub.get(pub.id);
    const list = listByPub.get(pub.id);
    if (isHiddenAudience(pub.slug)) {
      if (list?.has(user.id)) opened.add(pub.id);
      else if (!list && pub.slug !== AUDIENCE_SLUGS.RESTRICTED) legacy.push(pub);
      continue;
    }
    if (!groups) {
      legacy.push(pub);
      continue;
    }
    // Same requirement as the event rule: an active subscription.
    if (!hasActiveSubscription(user)) continue;
    const mine =
      pub.slug === AUDIENCE_SLUGS.GROUP_MEMBERS ? await userGroupIds() : await attendedGroupIds();
    if ([...groups].some((g) => mine.has(g))) opened.add(pub.id);
  }
  if (legacy.length === 0) return opened;

  const links = await db.query.eventPublications.findMany({
    where: inArray(
      eventPublications.publicationId,
      legacy.map((p) => p.id),
    ),
  });
  const eventIdsByPub = new Map<number, number[]>();
  for (const link of links) {
    const list = eventIdsByPub.get(link.publicationId) ?? [];
    list.push(link.eventId);
    eventIdsByPub.set(link.publicationId, list);
  }

  // Each linked event is checked once per audience, however many publications carry it.
  const decisions = new Map<string, Promise<boolean>>();
  const allowed = (eventId: number, slug: string) => {
    const key = `${slug}:${eventId}`;
    let result = decisions.get(key);
    if (!result) {
      // The publication's audience stands in for the event's own; the event's
      // publish status is not what decides who gets a text.
      result = checkEventAccess(user, { id: eventId, status: "published", audience: { slug } }).then(
        (r) => r.allowed,
      );
      decisions.set(key, result);
    }
    return result;
  };

  await Promise.all(
    legacy.map(async (pub) => {
      const eventIds = eventIdsByPub.get(pub.id) ?? [];
      const results = await Promise.all(eventIds.map((eventId) => allowed(eventId, pub.slug)));
      if (results.some(Boolean)) opened.add(pub.id);
    }),
  );
  return opened;
}
