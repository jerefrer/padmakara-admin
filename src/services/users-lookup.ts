import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";

type FoundUser = { id: number; email: string; preferredLanguage: string };

const columns = { id: users.id, email: users.email, preferredLanguage: users.preferredLanguage };

async function findByEmail(email: string): Promise<FoundUser | undefined> {
  const [row] = await db
    .select(columns)
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  return row;
}

/**
 * Find a user by email (trimmed, case-insensitive) or create one: active, not
 * verified, role user. Existing accounts keep their own language and name.
 */
export async function findOrCreateUserByEmail(input: {
  email: string;
  firstName?: string;
  lastName?: string;
  language: "pt" | "en";
}): Promise<{ user: FoundUser; created: boolean }> {
  const email = input.email.trim().toLowerCase();

  const existing = await findByEmail(email);
  if (existing) return { user: existing, created: false };

  const [inserted] = await db
    .insert(users)
    .values({
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      isActive: true,
      isVerified: false,
      role: "user",
      preferredLanguage: input.language,
    })
    .onConflictDoNothing()
    .returning(columns);
  if (inserted) return { user: inserted, created: true };

  // Lost a race with a concurrent insert of the same email: reuse the winner.
  const winner = await findByEmail(email);
  if (!winner) throw new Error("Could not create or find user");
  return { user: winner, created: false };
}
