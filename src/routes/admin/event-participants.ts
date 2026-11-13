import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { events } from "../../db/schema/retreats.ts";
import { users, userEventAttendance } from "../../db/schema/users.ts";
import { AppError } from "../../lib/errors.ts";
import { findOrCreateUserByEmail } from "../../services/users-lookup.ts";
import { parseEmailList } from "../../services/email-list.ts";
import { bumpUserAccessVersion } from "../../services/sync-versions.ts";

const eventParticipantRoutes = new Hono();

export const MAX_BATCH_EMAILS = 1000;

const addSchema = z.object({
  emails: z.array(z.string()).min(1).max(MAX_BATCH_EMAILS),
  language: z.enum(["pt", "en"]).optional(),
});

function parseId(raw: string, what: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest(`Invalid ${what} id`, "INVALID_ID");
  return id;
}

async function assertEventExists(id: number): Promise<void> {
  const event = await db.query.events.findFirst({ where: eq(events.id, id), columns: { id: true } });
  if (!event) throw AppError.notFound("Event not found");
}

const fullName = (first: string | null, last: string | null): string =>
  [first, last].filter(Boolean).join(" ").trim();

/** People marked as having attended the event, by name then email. */
eventParticipantRoutes.get("/:id/participants", async (c) => {
  const eventId = parseId(c.req.param("id"), "event");
  await assertEventExists(eventId);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      registeredAt: userEventAttendance.registeredAt,
    })
    .from(userEventAttendance)
    .innerJoin(users, eq(users.id, userEventAttendance.userId))
    .where(eq(userEventAttendance.eventId, eventId));

  return c.json(
    rows
      .map((r) => ({ id: r.id, email: r.email, name: fullName(r.firstName, r.lastName), registeredAt: r.registeredAt }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)),
  );
});

/**
 * Add participants from a list of emails. Accounts are created when missing and no
 * email is sent. `created` lists the addresses whose account was just created (they
 * are also in `added`), so the admin can check them for typos.
 */
eventParticipantRoutes.post("/:id/participants", async (c) => {
  const eventId = parseId(c.req.param("id"), "event");
  const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === "too_big");
    throw AppError.badRequest(
      tooMany ? `At most ${MAX_BATCH_EMAILS} emails at a time` : "Validation failed",
      tooMany ? "TOO_MANY_EMAILS" : "VALIDATION_ERROR",
    );
  }
  const { emails, language = "pt" } = parsed.data;
  await assertEventExists(eventId);

  const { valid, invalid } = parseEmailList(emails);
  const added: string[] = [];
  const alreadyHad: string[] = [];
  const created: string[] = [];
  for (const email of valid) {
    const { user, created: accountCreated } = await findOrCreateUserByEmail({ email, language });
    const rows = await db
      .insert(userEventAttendance)
      .values({ userId: user.id, eventId })
      .onConflictDoNothing()
      .returning({ userId: userEventAttendance.userId });
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

/** Remove one participant. Other access (grants, groups, admin) is not touched. */
eventParticipantRoutes.delete("/:id/participants/:userId", async (c) => {
  const eventId = parseId(c.req.param("id"), "event");
  const userId = parseId(c.req.param("userId"), "user");

  const removed = await db
    .delete(userEventAttendance)
    .where(and(eq(userEventAttendance.eventId, eventId), eq(userEventAttendance.userId, userId)))
    .returning({ userId: userEventAttendance.userId });
  if (removed.length === 0) throw AppError.notFound("Participant not found");

  await bumpUserAccessVersion(userId);
  return c.body(null, 204);
});

export { eventParticipantRoutes };
