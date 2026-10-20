import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { eventPublications } from "../db/schema/publications.ts";
import { users } from "../db/schema/users.ts";
import { checkEventAccess } from "./access.ts";
import { PUBLICATION_ACCESS_LEVELS } from "../lib/schemas.ts";

export { PUBLICATION_ACCESS_LEVELS };

/**
 * Who may open a publication.
 *
 * - `public`: anyone, signed in or not.
 * - `subscribers`: members.
 * - `events`: whoever can open at least one of the events it is linked to.
 *   Texts given at a retreat belong to that retreat's audience, so the event
 *   rules — participants, group members, initiation, on request — decide,
 *   kept in one place rather than copied onto every publication.
 */
export type PublicationAccessLevel = (typeof PUBLICATION_ACCESS_LEVELS)[number];

/**
 * The decision itself, given what the caller already knows. An access level
 * it does not recognise is refused: a restricted text must never fall open
 * because of a value nobody handled.
 */
export function canOpenPublication(
  accessLevel: string,
  who: { isAdmin: boolean; canSeeSubscriber: boolean; openedByLinkedEvent: boolean },
): boolean {
  switch (accessLevel) {
    case "public":
      return true;
    case "subscribers":
      return who.canSeeSubscriber;
    case "events":
      return who.isAdmin || who.openedByLinkedEvent;
    default:
      return false;
  }
}

/**
 * The publications, among `publicationIds`, that the user can open through at
 * least one linked event. Each event is checked once, however many
 * publications it carries.
 */
export async function publicationsOpenedByLinkedEvents(
  authUser: { id: number; role: string } | null,
  publicationIds: number[],
): Promise<Set<number>> {
  const opened = new Set<number>();
  if (publicationIds.length === 0) return opened;

  const links = await db.query.eventPublications.findMany({
    where: inArray(eventPublications.publicationId, publicationIds),
    with: { event: { with: { audience: true } } },
  });
  if (links.length === 0) return opened;

  // checkEventAccess needs the subscription state, which the token lacks.
  const user = authUser
    ? ((await db.query.users.findFirst({ where: eq(users.id, authUser.id) })) ?? null)
    : null;

  const eventAllowed = new Map<number, Promise<boolean>>();
  const allowed = (event: (typeof links)[number]["event"]) => {
    let result = eventAllowed.get(event.id);
    if (!result) {
      result = checkEventAccess(user, event).then((r) => r.allowed);
      eventAllowed.set(event.id, result);
    }
    return result;
  };

  await Promise.all(
    links.map(async (link) => {
      if (await allowed(link.event)) opened.add(link.publicationId);
    }),
  );
  return opened;
}
