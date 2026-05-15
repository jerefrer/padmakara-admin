import { Hono } from "hono";
import { z } from "zod";
import { createAccessToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";

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

export { testRoutes };
