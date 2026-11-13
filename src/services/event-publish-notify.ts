import { sendEmail } from "./email.ts";
import { buildTeachingPublishedEmail } from "./teaching-emails.ts";
import type { Recipient } from "./event-recipients.ts";

/** Gap between two emails, to stay under the SES send rate. */
export const PUBLISH_EMAIL_DELAY_MS = 100;

interface EventTitles {
  id: number;
  titleEn: string | null;
  titlePt: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Email each recipient that the event is now available, one by one and in their own
 * language, with the admin's personal message when there is one. A failure is logged and
 * does not stop the others. Returns how many were
 * sent and how many failed. Meant to run in the background after the route has answered.
 */
export async function sendPublishedEmails(
  event: EventTitles,
  recipients: Recipient[],
  delayMs: number = PUBLISH_EMAIL_DELAY_MS,
  message?: string,
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
      const mail = buildTeachingPublishedEmail({ lang, firstName: recipient.firstName, eventId: event.id, eventTitle: title, message });
      await sendEmail({ to: recipient.email, ...mail });
      sent++;
    } catch (err) {
      failed++;
      console.error(`[PUBLISH-EMAIL] could not email user ${recipient.id} about event ${event.id}:`, err);
    }
  }
  console.log(`[PUBLISH-EMAIL] event ${event.id}: ${sent} sent, ${failed} failed of ${recipients.length}`);
  return { sent, failed };
}
