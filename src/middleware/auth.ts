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
 * Optional auth middleware: extracts user if token present, continues without error otherwise.
 * Use for routes that work for both authenticated and unauthenticated users.
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  // Support token from Authorization header or ?token= query param (for iframe/direct URLs)
  const rawToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : c.req.query("token") || null;

  if (rawToken) {
    try {
      const payload = await verifyToken(rawToken);
      const user: AuthUser = {
        id: parseInt(payload.sub!, 10),
        email: payload.email!,
        role: payload.role!,
      };
      c.set("user", user);
    } catch {
      // Invalid token — treat as unauthenticated
    }
  }
  await next();
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

/**
 * Get the authenticated user from context, or null if not authenticated.
 */
export function getOptionalUser(c: Context): AuthUser | null {
  return (c.get("user") as AuthUser | undefined) ?? null;
}
