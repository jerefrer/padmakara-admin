import { sendEmail } from "./email.ts";
import { buildContentAnnouncementEmail } from "./teaching-emails.ts";
import type { Recipient } from "./event-recipients.ts";
import type { AnnouncementKind } from "../lib/announcement-kinds.ts";

/** Gap between two emails, to stay under the SES send rate (same as the publish email). */
const ANNOUNCE_EMAIL_DELAY_MS = 100;

interface EventTitles {
  id: number;
  titleEn: string | null;
  titlePt: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Email each recipient that new content (transcripts, videos, texts) is available, one by
 * one, in their own language. Same loop as sendPublishedEmails: a failure is logged and does
 * not stop the others. Meant to run in the background after the route has answered.
 */
export async function sendAnnouncementEmails(
  event: EventTitles,
  recipients: Recipient[],
  kinds: AnnouncementKind[],
  message?: string,
  delayMs: number = ANNOUNCE_EMAIL_DELAY_MS,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const [index, recipient] of recipients.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const lang = recipient.preferredLanguage === "pt" ? "pt" : "en";
      const title =
        (lang === "pt" ? event.titlePt || event.titleEn : event.titleEn || event.titlePt) ||
        `Event ${event.id}`;
      const mail = buildContentAnnouncementEmail({
        lang,
        firstName: recipient.firstName,
        eventId: event.id,
        eventTitle: title,
        kinds,
        message,
      });
      await sendEmail({ to: recipient.email, ...mail });
      sent++;
    } catch (err) {
      failed++;
      console.error(`[ANNOUNCE-EMAIL] could not email user ${recipient.id} about event ${event.id}:`, err);
    }
  }
  console.log(`[ANNOUNCE-EMAIL] event ${event.id} (${kinds.join(", ")}): ${sent} sent, ${failed} failed of ${recipients.length}`);
  return { sent, failed };
}
