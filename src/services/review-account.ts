import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

/**
 * Store-review demo account helpers. Everything reads `config.review` at call
 * time so the feature can be switched on/off by env alone (and by tests).
 */

/** True when `email` is the configured review account's (feature on or off). */
export function isReviewAccountEmail(email: string): boolean {
  return email.toLowerCase().trim() === config.review.email;
}

/** True when code sign-in is enabled AND `email` is the review account's. */
export function isReviewLoginFor(email: string): boolean {
  return config.review.code !== "" && isReviewAccountEmail(email);
}

/**
 * Constant-time comparison of two strings. Both sides are hashed first so the
 * buffers always have equal length (timingSafeEqual throws otherwise, and a
 * length check up front would leak the code's length).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** True when the feature is enabled and `code` matches the configured one. */
export function verifyReviewCode(code: string): boolean {
  if (config.review.code === "") return false;
  return safeEqual(code, config.review.code);
}
