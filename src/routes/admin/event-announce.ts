import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { events } from "../../db/schema/retreats.ts";
import { AppError } from "../../lib/errors.ts";
import { ANNOUNCEMENT_KINDS, type AnnouncementKind } from "../../lib/announcement-kinds.ts";
import { getUser } from "../../middleware/auth.ts";
import { listEventRecipients } from "../../services/event-recipients.ts";
import {
  countAnnounceableContent,
  listAnnouncements,
  recordAnnouncement,
} from "../../services/event-announcements.ts";
import { sendAnnouncementEmails } from "../../services/event-announcement-notify.ts";

const eventAnnounceRoutes = new Hono();

const MAX_MESSAGE_LENGTH = 1000;
const announceSchema = z.object({
  kinds: z.array(z.enum(ANNOUNCEMENT_KINDS)).min(1),
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
      transcriptsPublished: true,
      videoPublished: true,
      textsPublished: true,
    },
  });
  if (!event) throw AppError.notFound("Event not found");
  return event;
}

type EventRow = Awaited<ReturnType<typeof loadEvent>>;

/** The "Show in app" switch of each kind (a missing flag counts as shown, like the app). */
function isShown(event: EventRow, kind: AnnouncementKind): boolean {
  const flag = { transcripts: event.transcriptsPublished, videos: event.videoPublished, texts: event.textsPublished }[kind];
  return flag !== false;
}

/** Why a kind cannot be announced, or null when it can: shown in the app and not empty. */
function unavailableReason(event: EventRow, kind: AnnouncementKind, count: number): "hidden" | "empty" | null {
  if (!isShown(event, kind)) return "hidden";
  return count > 0 ? null : "empty";
}

/** What the announce dialog needs: who would get it, what can go out, and what already did. */
eventAnnounceRoutes.get("/:id/announcements", async (c) => {
  const event = await loadEvent(parseEventId(c.req.param("id")));
  const [recipients, counts, history] = await Promise.all([
    listEventRecipients(event.id),
    countAnnounceableContent(event.id),
    listAnnouncements(event.id),
  ]);

  const kinds = ANNOUNCEMENT_KINDS.map((kind) => {
    const reason = unavailableReason(event, kind, counts[kind]);
    // History is newest first: the first row naming the kind is its latest announcement
    const last = history.find((h) => h.kinds.includes(kind));
    return {
      kind,
      available: reason === null,
      ...(reason ? { reason } : {}),
      announcedAt: last ? last.sentAt.toISOString() : null,
    };
  });

  return c.json({
    recipients: recipients.length,
    published: event.publishedNotifiedAt
      ? { at: event.publishedNotifiedAt, count: event.publishedNotifiedCount ?? 0 }
      : null,
    kinds,
    history: history.map((h) => ({
      kinds: h.kinds,
      sentAt: h.sentAt.toISOString(),
      count: h.recipientCount,
      message: h.message,
    })),
  });
});

/**
 * Email everyone who has access that transcripts, videos and/or texts are now available.
 * Answers at once with the number queued and sends in the background. Refused unless the
 * event is published and every kind is shown and non-empty; refused for a kind already
 * announced unless `force` is set.
 */
eventAnnounceRoutes.post("/:id/announce", async (c) => {
  const parsed = announceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw AppError.badRequest("Validation failed", "VALIDATION_ERROR");
  const kinds = [...new Set(parsed.data.kinds)];
  const message = parsed.data.message || undefined;

  const event = await loadEvent(parseEventId(c.req.param("id")));
  if (event.status !== "published") {
    throw new AppError(409, "The event is not published", "EVENT_NOT_PUBLISHED");
  }

  const [counts, history] = await Promise.all([countAnnounceableContent(event.id), listAnnouncements(event.id)]);
  const unavailable = kinds.filter((kind) => unavailableReason(event, kind, counts[kind]) !== null);
  if (unavailable.length > 0) {
    throw new AppError(400, "Some content is not shown in the app or is empty", "KIND_NOT_AVAILABLE", { kinds: unavailable });
  }
  const already = kinds.filter((kind) => history.some((h) => h.kinds.includes(kind)));
  if (already.length > 0 && parsed.data.force !== true) {
    throw new AppError(409, "This content was already announced", "ALREADY_ANNOUNCED", { kinds: already });
  }

  const recipients = await listEventRecipients(event.id);
  if (recipients.length === 0) return c.json({ queued: 0 });

  await recordAnnouncement({
    eventId: event.id,
    kinds,
    message: message ?? null,
    recipientCount: recipients.length,
    sentBy: getUser(c).id,
  });

  // Background: the response must not wait for hundreds of emails
  void sendAnnouncementEmails(event, recipients, kinds, message).catch((err) => {
    console.error(`[ANNOUNCE-EMAIL] event ${event.id} aborted:`, err);
  });

  return c.json({ queued: recipients.length });
});

export { eventAnnounceRoutes };
