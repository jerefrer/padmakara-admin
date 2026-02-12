import type { Context, Next } from "hono";
import { verifyToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";

export interface AuthUser {
  id: number;
  email: string;
  role: string;
}

/**
 * Middleware that verifies the JWT access token from the Authorization header.
 * Sets c.set("user", ...) on success.
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw AppError.unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token);
    const user: AuthUser = {
      id: parseInt(payload.sub!, 10),
      email: payload.email!,
      role: payload.role!,
    };
    c.set("user", user);
    await next();
  } catch {
    throw AppError.unauthorized("Invalid or expired token");
  }
}

/**
 * Get the authenticated user from context. Throws if not authenticated.
 */
export function getUser(c: Context): AuthUser {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) {
    throw AppError.unauthorized();
  }
  return user;
}
