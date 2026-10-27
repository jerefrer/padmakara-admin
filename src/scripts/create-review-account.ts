/**
 * Create (or update) the store-review demo account and add it to retreat
 * groups so it sees real gated content. Idempotent.
 *
 *   bun run src/scripts/create-review-account.ts --groups 1,2,3
 *
 * The email comes from REVIEW_ACCOUNT_EMAIL (default review@padmakara.pt). The
 * account signs in with REVIEW_ACCOUNT_CODE (see /api/auth/review-login), so
 * no password is stored.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, userGroupMemberships } from "../db/schema/users.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { config } from "../config.ts";

export function parseGroupIds(argv: string[]): number[] {
  const i = argv.indexOf("--groups");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw) return [];
  const ids = raw.split(",").map((s) => Number(s.trim()));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`Invalid --groups value: ${raw} (expected e.g. 1,2,3)`);
  }
  return [...new Set(ids)];
}

async function main() {
  const email = config.review.email;
  const groupIds = parseGroupIds(process.argv.slice(2));

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  let userId: number;
  if (existing) {
    await db
      .update(users)
      .set({
        role: "user",
        isActive: true,
        isVerified: true,
        firstName: "App",
        lastName: "Review",
        preferredLanguage: "en",
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    userId = existing.id;
    console.log(`Updated review user ${email} (id ${userId})`);
  } else {
    const [created] = await db
      .insert(users)
      .values({
        email,
        role: "user",
        isActive: true,
        isVerified: true,
        firstName: "App",
        lastName: "Review",
        preferredLanguage: "en",
      })
      .returning({ id: users.id });
    userId = created!.id;
    console.log(`Created review user ${email} (id ${userId})`);
  }

  if (groupIds.length > 0) {
    const found = await db
      .select({ id: retreatGroups.id })
      .from(retreatGroups)
      .where(inArray(retreatGroups.id, groupIds));
    const foundIds = new Set(found.map((g) => g.id));
    const missing = groupIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) console.warn(`Skipped unknown group ids: ${missing.join(", ")}`);

    for (const retreatGroupId of foundIds) {
      await db
        .insert(userGroupMemberships)
        .values({ userId, retreatGroupId })
        .onConflictDoNothing();
      console.log(`Member of group ${retreatGroupId}`);
    }
  }

  if (config.review.code === "") {
    console.warn("REVIEW_ACCOUNT_CODE is empty: code sign-in is disabled until it is set.");
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
