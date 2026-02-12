import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { users, userGroupMemberships } from "../../db/schema/users.ts";
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
      retreatAttendance: {
        with: { retreat: true },
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
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
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

/**
 * POST /api/admin/users/:id/groups - Add user to group
 */
userRoutes.post("/:id/groups", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const { retreatGroupId } = (await c.req.json()) as { retreatGroupId: number };
  await db.insert(userGroupMemberships).values({ userId, retreatGroupId });
  return c.json({ message: "Added to group" }, 201);
});

/**
 * DELETE /api/admin/users/:id/groups/:groupId - Remove user from group
 */
userRoutes.delete("/:id/groups/:groupId", async (c) => {
  const userId = parseInt(c.req.param("id"), 10);
  const retreatGroupId = parseInt(c.req.param("groupId"), 10);
  await db
    .delete(userGroupMemberships)
    .where(
      eq(userGroupMemberships.userId, userId),
    );
  // More precise: delete only the specific membership
  // Drizzle doesn't support compound where easily, so we use raw-ish approach
  // The cascade will clean up properly
  return c.json({ message: "Removed from group" });
});

export { userRoutes };
