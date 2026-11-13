import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { users, userGroupMemberships } from "../../db/schema/users.ts";
import { AppError } from "../../lib/errors.ts";
import { findOrCreateUserByEmail } from "../../services/users-lookup.ts";
import { parseEmailList } from "../../services/email-list.ts";
import { bumpUserAccessVersion } from "../../services/sync-versions.ts";

const groupMemberRoutes = new Hono();

const MAX_BATCH_EMAILS = 1000;

const addSchema = z.object({
  emails: z.array(z.string()).min(1).max(MAX_BATCH_EMAILS),
  language: z.enum(["pt", "en"]).optional(),
});

function parseId(raw: string, what: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest(`Invalid ${what} id`, "INVALID_ID");
  return id;
}

async function assertGroupExists(id: number): Promise<void> {
  const group = await db.query.retreatGroups.findFirst({ where: eq(retreatGroups.id, id), columns: { id: true } });
  if (!group) throw AppError.notFound("Group not found");
}

const fullName = (first: string | null, last: string | null): string =>
  [first, last].filter(Boolean).join(" ").trim();

/** Members of the user group, by name then email. */
groupMemberRoutes.get("/:id/members", async (c) => {
  const groupId = parseId(c.req.param("id"), "group");
  await assertGroupExists(groupId);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      joinedAt: userGroupMemberships.joinedAt,
    })
    .from(userGroupMemberships)
    .innerJoin(users, eq(users.id, userGroupMemberships.userId))
    .where(eq(userGroupMemberships.retreatGroupId, groupId));

  return c.json(
    rows
      .map((r) => ({ id: r.id, email: r.email, name: fullName(r.firstName, r.lastName), registeredAt: r.joinedAt }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)),
  );
});

/**
 * Add members from a list of emails. Accounts are created when missing and no
 * email is sent. `created` lists the addresses whose account was just created (they
 * are also in `added`), so the admin can check them for typos.
 */
groupMemberRoutes.post("/:id/members", async (c) => {
  const groupId = parseId(c.req.param("id"), "group");
  const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === "too_big");
    throw AppError.badRequest(
      tooMany ? `At most ${MAX_BATCH_EMAILS} emails at a time` : "Validation failed",
      tooMany ? "TOO_MANY_EMAILS" : "VALIDATION_ERROR",
    );
  }
  const { emails, language = "pt" } = parsed.data;
  await assertGroupExists(groupId);

  const { valid, invalid } = parseEmailList(emails);
  const added: string[] = [];
  const alreadyHad: string[] = [];
  const created: string[] = [];
  for (const email of valid) {
    const { user, created: accountCreated } = await findOrCreateUserByEmail({ email, language });
    const rows = await db
      .insert(userGroupMemberships)
      .values({ userId: user.id, retreatGroupId: groupId })
      .onConflictDoNothing()
      .returning({ userId: userGroupMemberships.userId });
    if (rows.length === 0) {
      alreadyHad.push(email);
      continue;
    }
    added.push(email);
    if (accountCreated) created.push(email);
    await bumpUserAccessVersion(user.id);
  }

  return c.json({ added, alreadyHad, created, invalid });
});

/** Remove one member. Other access (grants, attendance, admin) is not touched. */
groupMemberRoutes.delete("/:id/members/:userId", async (c) => {
  const groupId = parseId(c.req.param("id"), "group");
  const userId = parseId(c.req.param("userId"), "user");

  const removed = await db
    .delete(userGroupMemberships)
    .where(and(eq(userGroupMemberships.retreatGroupId, groupId), eq(userGroupMemberships.userId, userId)))
    .returning({ userId: userGroupMemberships.userId });
  if (removed.length === 0) throw AppError.notFound("Member not found");

  await bumpUserAccessVersion(userId);
  return c.body(null, 204);
});

export { groupMemberRoutes };
