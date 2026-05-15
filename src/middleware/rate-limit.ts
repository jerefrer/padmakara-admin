/**
 * Rate-limiting middleware for auth endpoints.
 *
 * Uses hono-rate-limiter with an in-memory store.
 *
 * All limiters respect `config.rateLimit.enabled`.  When disabled (e.g. in the
 * unit-test environment) every factory returns a no-op pass-through middleware
 * so tests share a single app instance without fighting the limiter.
 *
 * In production the IP is taken from the `X-Forwarded-For` header (set by the
 * nginx reverse proxy) and falls back to a fixed sentinel when unavailable
 * (e.g. direct loopback connections from health checks).
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { config } from "../config.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Extract client IP from request headers. */
function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/** A pass-through middleware used when rate limiting is disabled. */
const passThrough: MiddlewareHandler = (_c: Context, next: Next) => next();

// ── exported factory functions ────────────────────────────────────────────────

/**
 * Per-IP rate limiter for sensitive auth endpoints (magic-link, approval, login).
 *
 * Production: 5 requests per 15 minutes per IP.
 */
export function authIpLimiter(opts?: {
  windowMs?: number;
  limit?: number;
}): MiddlewareHandler {
  if (!config.rateLimit.enabled) return passThrough;

  return rateLimiter({
    windowMs: opts?.windowMs ?? 15 * 60 * 1000, // 15 minutes
    limit: opts?.limit ?? 5,
    keyGenerator: (c) => `ip:${clientIp(c)}`,
    message: { error: "Too many requests. Please try again later." },
  });
}

/**
 * Per-email rate limiter for magic-link and approval endpoints.
 *
 * Keys on the `email` field in the JSON body so that a single IP cannot
 * send magic links to many different addresses.  Falls back to IP when the
 * body cannot be parsed (e.g. validation-error path).
 *
 * Production: 3 requests per 15 minutes per email.
 */
export function authEmailLimiter(opts?: {
  windowMs?: number;
  limit?: number;
}): MiddlewareHandler {
  if (!config.rateLimit.enabled) return passThrough;

  return rateLimiter({
    windowMs: opts?.windowMs ?? 15 * 60 * 1000, // 15 minutes
    limit: opts?.limit ?? 3,
    keyGenerator: async (c) => {
      try {
        // Clone so the body can still be read by the route handler.
        const clone = c.req.raw.clone();
        const body = (await clone.json()) as { email?: unknown };
        const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : null;
        if (email) return `email:${email}`;
      } catch {
        // Ignore parse errors — fall back to IP
      }
      return `ip:${clientIp(c)}`;
    },
    message: { error: "Too many requests. Please try again later." },
  });
}

/**
 * Looser per-IP rate limiter for the device/discover polling endpoint.
 *
 * Production: 30 requests per 5 minutes per IP.
 * (The app polls every few seconds while waiting for activation.)
 */
export function discoverIpLimiter(opts?: {
  windowMs?: number;
  limit?: number;
}): MiddlewareHandler {
  if (!config.rateLimit.enabled) return passThrough;

  return rateLimiter({
    windowMs: opts?.windowMs ?? 5 * 60 * 1000, // 5 minutes
    limit: opts?.limit ?? 30,
    keyGenerator: (c) => `ip:${clientIp(c)}`,
    message: { error: "Too many requests. Please try again later." },
  });
}
