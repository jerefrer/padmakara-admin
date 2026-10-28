import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

/** Wrong guesses allowed per token before its code stops working. */
export const MAX_CODE_ATTEMPTS = 5;

/** A 6-digit decimal code, zero-padded ("004217"). */
export function generateSignInCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * HMAC-SHA256 of the code keyed with the server's JWT secret, as hex. A plain
 * hash would be brute-forced offline in microseconds (only 10^6 codes) by
 * anyone who read the table; the keyed hash is useless without the secret.
 */
export function hashSignInCode(code: string): string {
  return createHmac("sha256", config.jwt.secret).update(`sign-in-code:${code}`).digest("hex");
}

/** Constant-time check of `code` against a stored hash. Never throws. */
export function verifySignInCode(code: string, hash: string): boolean {
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(hashSignInCode(code), "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
