import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { events } from "../../db/schema/retreats.ts";
import { AppError } from "../../lib/errors.ts";
import { AUDIENCE_SLUGS } from "../../services/access.ts";
import { listEventRecipients } from "../../services/event-recipients.ts";
import { sendPublishedEmails } from "../../services/event-publish-notify.ts";

const eventNotifyRoutes = new Hono();

const MAX_MESSAGE_LENGTH = 1000;
const notifySchema = z.object({
  force: z.boolean().optional(),
  // Plain text added to the email; trimmed first so a blank one counts as none
  message: z.string().trim().max(MAX_MESSAGE_LENGTH).optional(),
});

function parseEventId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("Invalid event id", "INVALID_ID");
  return id;
}

async function loadEvent(id: number) {
  const event = await db.query.events.findFirst({
    where: eq(events.id, id),
    columns: {
      id: true,
      status: true,
      titleEn: true,
      titlePt: true,
      publishedNotifiedAt: true,
      publishedNotifiedCount: true,
    },
    with: { audience: { columns: { slug: true } } },
  });
  if (!event) throw AppError.notFound("Event not found");
  return event;
}

// Open to everyone or to any account, the email reaches the whole user base, like a
// newsletter: André keeps those for major events, so the box starts unticked.
// A function, not a constant: read lazily so test mocks of access.ts need not export the slugs.
const isBroadAudience = (slug: string | undefined): boolean =>
  slug === AUDIENCE_SLUGS.PUBLIC || slug === AUDIENCE_SLUGS.ACCOUNT_HOLDERS;

/** How many people would get the "now available" email, and whether it was already sent. */
eventNotifyRoutes.get("/:id/recipients", async (c) => {
  const event = await loadEvent(parseEventId(c.req.param("id")));
  const recipients = await listEventRecipients(event.id);
  return c.json({
    count: recipients.length,
    notifiedAt: event.publishedNotifiedAt,
    notifiedCount: event.publishedNotifiedCount,
    notifyByDefault: !isBroadAudience(event.audience?.slug),
  });
});

/**
 * Email everyone who has access that the event is now available. Answers at once with the
 * number queued and sends in the background. Refused unless the event is published, and
 * refused a second time unless `force` is set.
 */
eventNotifyRoutes.post("/:id/notify-published", async (c) => {
  const parsed = notifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw AppError.badRequest("Validation failed", "VALIDATION_ERROR");
  const force = parsed.data.force === true;
  const message = parsed.data.message || undefined;

  const event = await loadEvent(parseEventId(c.req.param("id")));
  if (event.status !== "published") {
    throw new AppError(409, "The event is not published", "EVENT_NOT_PUBLISHED");
  }
  if (event.publishedNotifiedAt && !force) {
    throw new AppError(409, "The people with access were already emailed", "ALREADY_NOTIFIED");
  }

  const recipients = await listEventRecipients(event.id);
  if (recipients.length === 0) return c.json({ queued: 0 });

  // Claim the send in one statement so two clicks cannot both go through
  const claimed = await db
    .update(events)
    .set({ publishedNotifiedAt: new Date(), publishedNotifiedCount: recipients.length })
    .where(
      force
        ? eq(events.id, event.id)
        : and(eq(events.id, event.id), isNull(events.publishedNotifiedAt)),
    )
    .returning({ id: events.id });
  if (claimed.length === 0) {
    throw new AppError(409, "The people with access were already emailed", "ALREADY_NOTIFIED");
  }

  // Background: the response must not wait for hundreds of emails
  void sendPublishedEmails(event, recipients, undefined, message).catch((err) => {
    console.error(`[PUBLISH-EMAIL] event ${event.id} aborted:`, err);
  });

  return c.json({ queued: recipients.length });
});

export { eventNotifyRoutes };
