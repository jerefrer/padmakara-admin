import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema/users.ts";
import { updateUserSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { isReviewAccountEmail } from "../../services/review-account.ts";
import { bumpUserAccessVersion } from "../../services/sync-versions.ts";
import {
  listUserEventGrants,
  listUserPublications,
  replaceUserAttendance,
  replaceUserGroups,
} from "../../services/user-access.ts";

const userRoutes = new Hono();

const columns: Record<string, any> = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  dharmaName: users.dharmaName,
  subscriptionStatus: users.subscriptionStatus,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
  lastActivity: users.lastActivity,
};

userRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  // Free-text search, used by the user pickers of the admin.
  const q = c.req.query("q")?.trim();
  const where = q
    ? or(
        ilike(users.email, `%${q}%`),
        ilike(users.firstName, `%${q}%`),
        ilike(users.lastName, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.query.users.findMany({
      where,
      orderBy: orderBy ? [orderBy] : undefined,
      limit,
      offset,
      columns: {
        passwordHash: false,
      },
      with: {
        groupMemberships: {
          with: { retreatGroup: true },
        },
      },
    }),
    countRows(users, where),
  ]);

  // The admin cannot read server env, so flag the store-review account here.
  const withFlag = data.map((u) => ({ ...u, isReviewAccount: isReviewAccountEmail(u.email) }));
  return listResponse(c, withFlag, total, offset, offset + limit, "users");
});

userRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
    columns: {
      passwordHash: false,
    },
    with: {
      groupMemberships: {
        with: { retreatGroup: true },
      },
      eventAttendance: {
        with: { event: true },
      },
    },
  });
  if (!user) throw AppError.notFound("User not found");
  const [eventGrants, grantedPublications] = await Promise.all([
    listUserEventGrants(id),
    listUserPublications(id),
  ]);
  return c.json({
    ...user,
    isReviewAccount: isReviewAccountEmail(user.email),
    retreatGroupIds: user.groupMemberships.map((m) => m.retreatGroupId),
    attendedEventIds: user.eventAttendance.map((a) => a.eventId),
    eventGrants,
    grantedPublications,
  });
});

userRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const { retreatGroupIds, attendedEventIds, ...data } = updateUserSchema.parse(body);

  // Handle subscriptionExpiresAt string → Date conversion
  const setData: Record<string, any> = { ...data, updatedAt: new Date() };
  if (data.subscriptionExpiresAt !== undefined) {
    setData.subscriptionExpiresAt = data.subscriptionExpiresAt
      ? new Date(data.subscriptionExpiresAt)
      : null;
  }

  const user = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set(setData)
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        dharmaName: users.dharmaName,
        preferredLanguage: users.preferredLanguage,
        role: users.role,
        isActive: users.isActive,
        isVerified: users.isVerified,
        subscriptionStatus: users.subscriptionStatus,
        subscriptionSource: users.subscriptionSource,
        subscriptionExpiresAt: users.subscriptionExpiresAt,
        subscriptionNotes: users.subscriptionNotes,
        lastActivity: users.lastActivity,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      });
    if (!updated) return null;
    if (retreatGroupIds) await replaceUserGroups(tx, id, retreatGroupIds);
    if (attendedEventIds) await replaceUserAttendance(tx, id, attendedEventIds);
    return updated;
  });
  if (!user) throw AppError.notFound("User not found");
  // Any of these changes can affect what content the user can access.
  bumpUserAccessVersion(id).catch((err) =>
    console.error("[sync] failed to bump user access version:", err),
  );
  return c.json({
    ...user,
    isReviewAccount: isReviewAccountEmail(user.email),
    ...(retreatGroupIds && { retreatGroupIds }),
    ...(attendedEventIds && { attendedEventIds }),
  });
});

userRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [user] = await db.delete(users).where(eq(users.id, id)).returning({
    id: users.id,
    email: users.email,
  });
  if (!user) throw AppError.notFound("User not found");
  return c.json(user);
});

export { userRoutes };
