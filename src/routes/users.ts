import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";

const userRoutes = new Hono();

userRoutes.use("*", authMiddleware);

/**
 * GET /api/users/profile - Get current user profile
 */
userRoutes.get("/profile", async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
    columns: { passwordHash: false },
    with: {
      groupMemberships: {
        with: { retreatGroup: true },
      },
    },
  });

  if (!user) throw AppError.notFound("User not found");
  return c.json(user);
});

/**
 * PUT /api/users/profile - Update current user profile
 */
userRoutes.put("/profile", async (c) => {
  const authUser = getUser(c);
  const body = await c.req.json();

  // Only allow users to update their own profile fields
  const { firstName, lastName, dharmaName, preferredLanguage } = body as {
    firstName?: string;
    lastName?: string;
    dharmaName?: string;
    preferredLanguage?: string;
  };

  const [user] = await db
    .update(users)
    .set({
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(dharmaName !== undefined && { dharmaName }),
      ...(preferredLanguage !== undefined && { preferredLanguage }),
      updatedAt: new Date(),
    })
    .where(eq(users.id, authUser.id))
    .returning({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      dharmaName: users.dharmaName,
      preferredLanguage: users.preferredLanguage,
      role: users.role,
      isVerified: users.isVerified,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    });

  if (!user) throw AppError.notFound("User not found");
  return c.json(user);
});

export { userRoutes };
