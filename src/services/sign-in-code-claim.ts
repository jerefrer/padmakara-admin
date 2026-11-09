import { eq, and, gt, lt, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { magicLinkTokens } from "../db/schema/auth.ts";
import { verifySignInCode, MAX_CODE_ATTEMPTS } from "./sign-in-code.ts";

type MagicLinkToken = typeof magicLinkTokens.$inferSelect;

/**
 * Find the unused, unexpired token sent to `email` for `deviceFingerprint`
 * whose code is `code`, and consume it. A wrong code counts one attempt on
 * every candidate; a token stops accepting codes at MAX_CODE_ATTEMPTS. Returns
 * null on any failure, so callers can answer every case with the same error.
 */
export async function claimSignInCode(
  email: string,
  deviceFingerprint: string,
  code: string,
): Promise<MagicLinkToken | null> {
  const now = new Date();
  const rows = await db.query.magicLinkTokens.findMany({
    where: and(
      eq(magicLinkTokens.email, email),
      eq(magicLinkTokens.deviceFingerprint, deviceFingerprint),
      eq(magicLinkTokens.isUsed, false),
      gt(magicLinkTokens.expiresAt, now),
      isNotNull(magicLinkTokens.codeHash),
      lt(magicLinkTokens.codeAttempts, MAX_CODE_ATTEMPTS),
    ),
  });
  // The query already filters; re-check so a bug there cannot widen the match.
  const candidates = rows.filter(
    (r) =>
      !r.isUsed &&
      r.expiresAt > now &&
      r.codeHash !== null &&
      r.codeAttempts < MAX_CODE_ATTEMPTS &&
      r.deviceFingerprint === deviceFingerprint,
  );

  // Check every candidate (no early exit) so timing does not depend on which row matched.
  let matched: MagicLinkToken | undefined;
  for (const row of candidates) {
    if (verifySignInCode(code, row.codeHash as string) && !matched) matched = row;
  }

  if (!matched) {
    if (candidates.length > 0) {
      await db
        .update(magicLinkTokens)
        .set({ codeAttempts: sql`${magicLinkTokens.codeAttempts} + 1` })
        .where(inArray(magicLinkTokens.id, candidates.map((r) => r.id)));
    }
    return null;
  }

  // Consume atomically: of two concurrent requests with the right code only one wins.
  const consumed = await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(and(eq(magicLinkTokens.id, matched.id), eq(magicLinkTokens.isUsed, false)))
    .returning({ id: magicLinkTokens.id });
  if (consumed.length === 0) return null;

  return matched;
}
