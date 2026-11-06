import { and, desc, eq, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.ts";
import { eventAccessGrants } from "../db/schema/event-access.ts";
import { publicationAccessUsers, publications } from "../db/schema/publications.ts";
import { events } from "../db/schema/retreats.ts";
import { userEventAttendance, userGroupMemberships, users } from "../db/schema/users.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Events the user bought, claimed or was given, newest first, with who gave them. */
export async function listUserEventGrants(userId: number) {
  const admin = alias(users, "granting_admin");
  const rows = await db
    .select({
      eventId: eventAccessGrants.eventId,
      eventCode: events.eventCode,
      titleEn: events.titleEn,
      titlePt: events.titlePt,
      source: eventAccessGrants.source,
      createdAt: eventAccessGrants.createdAt,
      adminEmail: admin.email,
      adminFirstName: admin.firstName,
      adminLastName: admin.lastName,
    })
    .from(eventAccessGrants)
    .innerJoin(events, eq(events.id, eventAccessGrants.eventId))
    .leftJoin(admin, eq(admin.id, eventAccessGrants.grantedBy))
    .where(eq(eventAccessGrants.userId, userId))
    .orderBy(desc(eventAccessGrants.createdAt));

  return rows.map(({ adminEmail, adminFirstName, adminLastName, ...grant }) => ({
    ...grant,
    grantedBy: [adminFirstName, adminLastName].filter(Boolean).join(" ") || adminEmail,
  }));
}

/** Hidden publications an admin granted to the user. */
export async function listUserPublications(userId: number) {
  return db
    .select({ id: publications.id, title: publications.title })
    .from(publicationAccessUsers)
    .innerJoin(publications, eq(publications.id, publicationAccessUsers.publicationId))
    .where(eq(publicationAccessUsers.userId, userId))
    .orderBy(publications.title);
}

/** Make the user's groups exactly `groupIds`. Kept rows keep their join date. */
export async function replaceUserGroups(tx: Tx, userId: number, groupIds: number[]) {
  const ids = [...new Set(groupIds)];
  await tx
    .delete(userGroupMemberships)
    .where(
      ids.length > 0
        ? and(eq(userGroupMemberships.userId, userId), notInArray(userGroupMemberships.retreatGroupId, ids))
        : eq(userGroupMemberships.userId, userId),
    );
  if (ids.length > 0) {
    await tx
      .insert(userGroupMemberships)
      .values(ids.map((retreatGroupId) => ({ userId, retreatGroupId })))
      .onConflictDoNothing();
  }
}

/** Make the user's attended events exactly `eventIds`. Kept rows keep their date. */
export async function replaceUserAttendance(tx: Tx, userId: number, eventIds: number[]) {
  const ids = [...new Set(eventIds)];
  await tx
    .delete(userEventAttendance)
    .where(
      ids.length > 0
        ? and(eq(userEventAttendance.userId, userId), notInArray(userEventAttendance.eventId, ids))
        : eq(userEventAttendance.userId, userId),
    );
  if (ids.length > 0) {
    await tx
      .insert(userEventAttendance)
      .values(ids.map((eventId) => ({ userId, eventId })))
      .onConflictDoNothing();
  }
}
