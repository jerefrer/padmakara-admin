import type { Context, Next } from "hono";
import { verifyAccessToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";
import { markActive } from "../services/usage.ts";

export interface AuthUser {
  id: number;
  email: string;
  role: string;
}

/** Builds the request user from a verified payload, or null when a required claim is missing. */
function userFromPayload(payload: { sub?: string; email?: string; role?: string }): AuthUser | null {
  if (!payload.sub || !payload.email || !payload.role) return null;
  const id = parseInt(payload.sub, 10);
  if (Number.isNaN(id)) return null;
  return { id, email: payload.email, role: payload.role };
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
    const payload = await verifyAccessToken(token);
    const user = userFromPayload(payload);
    if (!user) throw new Error("token is missing sub, email or role");
    c.set("user", user);
    markActive(user.id);
    await next();
  } catch {
    throw AppError.unauthorized("Invalid or expired token");
  }
}

/**
 * Optional auth middleware: extracts user if token present, continues without error otherwise.
 * Use for routes that work for both authenticated and unauthenticated users.
 *
 * Auth tokens are accepted ONLY from the Authorization: Bearer header.
 * The former ?token= query-parameter fallback has been removed: tokens in URLs
 * leak into access logs, browser history, and Referer headers. The MAT system
 * (media-access.ts) already covers the legitimate HLS use case with a purpose-
 * built, scoped short-lived token passed via ?mat=.
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (rawToken) {
    try {
      const payload = await verifyAccessToken(rawToken);
      const user = userFromPayload(payload);
      if (user) {
        c.set("user", user);
        markActive(user.id);
      }
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
