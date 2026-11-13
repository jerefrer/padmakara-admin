import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { events } from "../../db/schema/retreats.ts";
import { users } from "../../db/schema/users.ts";
import { eventAccessGrants, teachingOrders } from "../../db/schema/event-access.ts";
import { AppError } from "../../lib/errors.ts";
import { getUser } from "../../middleware/auth.ts";
import { findOrCreateUserByEmail } from "../../services/users-lookup.ts";
import { grantEventAccess } from "../../services/event-access.ts";
import { sendTeachingAvailableEmail } from "../../services/teaching-orders.ts";
import { bumpUserAccessVersion } from "../../services/sync-versions.ts";
import { parseEmailList } from "../../services/email-list.ts";

const eventAccessRoutes = new Hono();

export const MAX_ACCESS_EMAILS = 200;

const addAccessSchema = z.object({
  emails: z.array(z.string()).min(1).max(MAX_ACCESS_EMAILS),
  notify: z.boolean(),
  language: z.enum(["pt", "en"]).optional(),
});

function parseEventId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("Invalid event id", "INVALID_ID");
  return id;
}

async function assertEventExists(id: number): Promise<void> {
  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    columns: { id: true },
  });
  if (!event) throw AppError.notFound("Event not found");
}

const fullName = (first: string | null, last: string | null): string =>
  [first, last].filter(Boolean).join(" ").trim();

/** People with access to the event, orders waiting for payment, and sale stats. */
eventAccessRoutes.get("/:id/access", async (c) => {
  const eventId = parseEventId(c.req.param("id"));
  await assertEventExists(eventId);

  const admin = alias(users, "granting_admin");

  const grantRows = await db
    .select({
      userId: eventAccessGrants.userId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      source: eventAccessGrants.source,
      orderId: eventAccessGrants.orderId,
      method: teachingOrders.method,
      amountCents: teachingOrders.amountCents,
      createdAt: eventAccessGrants.createdAt,
      grantedById: eventAccessGrants.grantedBy,
      grantedByEmail: admin.email,
      grantedByFirstName: admin.firstName,
      grantedByLastName: admin.lastName,
    })
    .from(eventAccessGrants)
    .innerJoin(users, eq(users.id, eventAccessGrants.userId))
    .leftJoin(teachingOrders, eq(teachingOrders.id, eventAccessGrants.orderId))
    .leftJoin(admin, eq(admin.id, eventAccessGrants.grantedBy))
    .where(eq(eventAccessGrants.eventId, eventId))
    .orderBy(sql`${eventAccessGrants.createdAt} desc`);

  const pendingRows = await db
    .select({
      id: teachingOrders.id,
      email: teachingOrders.email,
      firstName: teachingOrders.firstName,
      lastName: teachingOrders.lastName,
      amountCents: teachingOrders.amountCents,
      createdAt: teachingOrders.createdAt,
    })
    .from(teachingOrders)
    .where(and(eq(teachingOrders.eventId, eventId), eq(teachingOrders.status, "pending")))
    .orderBy(sql`${teachingOrders.createdAt} desc`);

  const [totals] = await db
    .select({
      paidCount: sql<number>`count(*) filter (where ${teachingOrders.status} = 'paid')::int`,
      collectedCents: sql<number>`coalesce(sum(${teachingOrders.amountCents}) filter (where ${teachingOrders.status} = 'paid'), 0)::int`,
      pendingCount: sql<number>`count(*) filter (where ${teachingOrders.status} = 'pending')::int`,
    })
    .from(teachingOrders)
    .where(eq(teachingOrders.eventId, eventId));

  return c.json({
    grants: grantRows.map((g) => ({
      userId: g.userId,
      email: g.email,
      name: fullName(g.firstName, g.lastName),
      source: g.source,
      orderId: g.orderId,
      method: g.method,
      amountCents: g.amountCents,
      createdAt: g.createdAt,
      grantedBy: g.grantedById
        ? {
            id: g.grantedById,
            email: g.grantedByEmail,
            name: fullName(g.grantedByFirstName, g.grantedByLastName),
          }
        : null,
    })),
    pendingOrders: pendingRows.map((o) => ({
      id: o.id,
      email: o.email,
      name: fullName(o.firstName, o.lastName),
      amountCents: o.amountCents,
      createdAt: o.createdAt,
    })),
    stats: {
      paidCount: Number(totals?.paidCount ?? 0),
      collectedCents: Number(totals?.collectedCents ?? 0),
      pendingCount: Number(totals?.pendingCount ?? 0),
    },
  });
});

/** Give access by hand to a list of emails (accounts are created when missing). */
eventAccessRoutes.post("/:id/access", async (c) => {
  const eventId = parseEventId(c.req.param("id"));
  const admin = getUser(c);
  const parsed = addAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === "too_big");
    throw AppError.badRequest(
      tooMany ? `At most ${MAX_ACCESS_EMAILS} emails at a time` : "Validation failed",
      tooMany ? "TOO_MANY_EMAILS" : "VALIDATION_ERROR",
    );
  }
  const { emails, notify, language = "pt" } = parsed.data;
  await assertEventExists(eventId);

  const { valid, invalid } = parseEmailList(emails);

  const added: string[] = [];
  const alreadyHad: string[] = [];
  for (const email of valid) {
    const { user } = await findOrCreateUserByEmail({ email, language });
    const { created } = await grantEventAccess({
      userId: user.id,
      eventId,
      source: "manual",
      grantedBy: admin.id,
    });
    if (!created) {
      alreadyHad.push(email);
      continue;
    }
    added.push(email);
    if (notify) {
      await sendTeachingAvailableEmail({
        eventId,
        email,
        firstName: "",
        language,
      });
    }
  }

  return c.json({ added, alreadyHad, invalid });
});

/** Remove one person's grant. Group or admin access is not touched. */
eventAccessRoutes.delete("/:id/access/:userId", async (c) => {
  const eventId = parseEventId(c.req.param("id"));
  const userId = Number(c.req.param("userId"));
  if (!Number.isInteger(userId) || userId <= 0) {
    throw AppError.badRequest("Invalid user id", "INVALID_ID");
  }

  const removed = await db
    .delete(eventAccessGrants)
    .where(and(eq(eventAccessGrants.eventId, eventId), eq(eventAccessGrants.userId, userId)))
    .returning({ userId: eventAccessGrants.userId });
  if (removed.length === 0) throw AppError.notFound("Access grant not found");

  await bumpUserAccessVersion(userId);
  return c.json({ success: true });
});

export { eventAccessRoutes };
