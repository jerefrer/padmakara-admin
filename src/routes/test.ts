import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createAccessToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";

/**
 * Test-only routes. Mounted by routes/index.ts ONLY when NODE_ENV !== "production".
 * Never available in production.
 */
const testRoutes = new Hono();

const tokenSchema = z.object({
  userId: z.number().int().positive(),
  email: z.string().email(),
  role: z.enum(["user", "admin", "superadmin"]).default("user"),
});

testRoutes.post("/token", async (c) => {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid test-token request", "VALIDATION_ERROR");
  }
  const { userId, email, role } = parsed.data;
  const token = await createAccessToken({ sub: userId, email, role });
  return c.json({ token });
});

/**
 * GET /api/test/user-by-email?email=...
 *
 * Resolve a seeded user's DB id + role from their email so the Playwright
 * auth helper can mint a token without hard-coding seed-order ids. Test-only.
 */
testRoutes.get("/user-by-email", async (c) => {
  const email = c.req.query("email")?.trim();
  if (!email) {
    throw AppError.badRequest("Missing email query param", "VALIDATION_ERROR");
  }
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, email: true, role: true },
  });
  if (!row) {
    throw AppError.notFound(`No user with email "${email}"`);
  }
  return c.json({ id: row.id, email: row.email, role: row.role });
});

export { testRoutes };
