import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { findOrCreateUserByEmail } from "./users-lookup.ts";

type User = typeof users.$inferSelect;

/**
 * The account a completed email sign-in (link or code) belongs to. An address
 * with no account gets one here, on its first sign-in: whoever can open the
 * email owns the address, so nothing is created before that. The new account
 * is active and sees only public content until access is given. Returns null
 * for a deactivated account.
 */
export async function accountForEmailSignIn(email: string, language: string | null): Promise<User | null> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) return existing.isActive ? existing : null;

  const { user } = await findOrCreateUserByEmail({ email, language: language === "pt" ? "pt" : "en" });
  const created = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  return created?.isActive ? created : null;
}
