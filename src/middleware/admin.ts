import type { Context, Next } from "hono";
import { getUser } from "./auth.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Middleware that checks the authenticated user has admin or superadmin role.
 * Must be used after authMiddleware.
 */
export async function adminMiddleware(c: Context, next: Next) {
  const user = getUser(c);
  if (user.role !== "admin" && user.role !== "superadmin") {
    throw AppError.forbidden("Admin access required");
  }
  await next();
}
