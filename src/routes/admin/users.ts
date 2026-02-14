import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { users, userGroupMemberships, userEventAttendance } from "../../db/schema/users.ts";
import { updateUserSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

const userRoutes = new Hono();

const columns: Record<string, any> = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
  lastActivity: users.lastActivity,
};

userRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);

  const [data, total] = await Promise.all([
    db.query.users.findMany({
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
    countRows(users),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "users");
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
  return c.json(user);
});

userRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateUserSchema.parse(body);

  // Handle subscriptionExpiresAt string → Date conversion
  const setData: Record<string, any> = { ...data, updatedAt: new Date() };
  if (data.subscriptionExpiresAt !== undefined) {
    setData.subscriptionExpiresAt = data.subscriptionExpiresAt
      ? new Date(data.subscriptionExpiresAt)
      : null;
  }

  const [user] = await db
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
  if (!user) throw AppError.notFound("User not found");
  return c.json(user);
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

// ─── Group memberships ──────────────────────────────────────────────────────

userRoutes.post("/:id/groups", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const { retreatGroupId } = (await c.req.json()) as { retreatGroupId: number };
  await db.insert(userGroupMemberships).values({ userId, retreatGroupId });
  return c.json({ message: "Added to group" }, 201);
});

userRoutes.delete("/:id/groups/:groupId", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const retreatGroupId = parseInt(c.req.param("groupId"), 10);
  await db
    .delete(userGroupMemberships)
    .where(
      and(
        eq(userGroupMemberships.userId, userId),
        eq(userGroupMemberships.retreatGroupId, retreatGroupId),
      ),
    );
  return c.json({ message: "Removed from group" });
});

// ─── Event attendance ───────────────────────────────────────────────────────

userRoutes.post("/:id/events", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const { eventId } = (await c.req.json()) as { eventId: number };
  await db.insert(userEventAttendance).values({ userId, eventId });
  return c.json({ message: "Added to event" }, 201);
});

userRoutes.delete("/:id/events/:eventId", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const eventId = parseInt(c.req.param("eventId"), 10);
  await db
    .delete(userEventAttendance)
    .where(
      and(
        eq(userEventAttendance.userId, userId),
        eq(userEventAttendance.eventId, eventId),
      ),
    );
  return c.json({ message: "Removed from event" });
});

export { userRoutes };
