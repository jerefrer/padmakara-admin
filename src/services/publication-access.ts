import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { audiences } from "../db/schema/audiences.ts";
import { eventPublications } from "../db/schema/publications.ts";
import { users } from "../db/schema/users.ts";
import { AUDIENCE_SLUGS, checkEventAccess, hasActiveSubscription } from "./access.ts";

/**
 * Who may open a publication.
 *
 * A publication carries the same audience as an event, and the rule is the
 * event rule (`checkEventAccess`):
 *
 * - public: anyone, signed in or not.
 * - subscribers: members.
 * - event participants, retreat group members, received initiation, on
 *   request: the events the publication is linked to decide. The user must
 *   pass that audience's rule for at least one of them — attended it, belongs
 *   to one of its groups, or was granted it by an admin — with the same
 *   membership requirements as for the event itself.
 *
 * Admins open everything with a known audience. A publication with an
 * event-based audience and no linked events is open to nobody else. An
 * audience that is missing or not recognised is refused for everyone: a
 * restricted text must never fall open because of a value nobody handled.
 */
// Read lazily: modules that mock access.ts partially must still be able to import this one.
const knownAudiences = (): string[] => [
  AUDIENCE_SLUGS.PUBLIC,
  AUDIENCE_SLUGS.SUBSCRIBERS,
  AUDIENCE_SLUGS.EVENT_PARTICIPANTS,
  AUDIENCE_SLUGS.GROUP_MEMBERS,
  AUDIENCE_SLUGS.INITIATION,
  AUDIENCE_SLUGS.ON_REQUEST,
];

/** Audience id -> slug, for deciding on rows that only carry the id. */
export async function publicationAudienceSlugs(): Promise<Map<number, string>> {
  const rows = await db.select().from(audiences);
  return new Map(rows.map((a) => [a.id, a.slug]));
}

/** Whether a publication with this audience is made for members alone. */
export function isMemberOnlyAudience(slug: string | null | undefined): boolean {
  return slug === AUDIENCE_SLUGS.SUBSCRIBERS;
}

/**
 * The publications, among `pubs`, that the caller can open. One decision for
 * every route (list, PDF, event page); each linked event is checked once per
 * audience, however many publications carry it.
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

  const eventBased: { id: number; slug: string }[] = [];
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
      eventBased.push({ id: pub.id, slug });
    }
  }
  if (eventBased.length === 0) return opened;

  const links = await db.query.eventPublications.findMany({
    where: inArray(
      eventPublications.publicationId,
      eventBased.map((p) => p.id),
    ),
  });
  const eventIdsByPub = new Map<number, number[]>();
  for (const link of links) {
    const list = eventIdsByPub.get(link.publicationId) ?? [];
    list.push(link.eventId);
    eventIdsByPub.set(link.publicationId, list);
  }

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
    eventBased.map(async (pub) => {
      const eventIds = eventIdsByPub.get(pub.id) ?? [];
      const results = await Promise.all(eventIds.map((eventId) => allowed(eventId, pub.slug)));
      if (results.some(Boolean)) opened.add(pub.id);
    }),
  );
  return opened;
}
