import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { teachingOrders, eventAccessGrants } from "../db/schema/event-access.ts";
import { sendEmail } from "./email.ts";
import { buildTeachingAvailableEmail } from "./teaching-emails.ts";
import { bumpUserAccessVersion } from "./sync-versions.ts";
import { easypayFetch, isMockMode, EasypayHttpError } from "../routes/payment.ts";

export type TeachingOrder = typeof teachingOrders.$inferSelect;
export type FinalizeResult = "finalized" | "already" | "amount_mismatch";

/** The `key` we put on the Easypay payment and order for a teaching order. */
export function teachingOrderKey(publicId: string): string {
  return `teaching-order-${publicId}`;
}

/**
 * Turn a paid order into access. Idempotent and safe to race (webhook, polling,
 * duplicate notifications): the status flip is a single UPDATE ... WHERE
 * status = 'pending', so exactly one caller wins; only that caller grants access
 * and sends the email. The flip and the grant share one transaction, so a crash
 * cannot leave a paid order without its grant.
 *
 * The amount is verified here, not by callers: a payment that does not match the
 * order amount is logged and leaves the order pending for a human to look at.
 */
export async function finalizeOrder(
  orderId: number,
  payment: { paymentId: string; method?: string; amountCents: number },
): Promise<FinalizeResult> {
  const order = await db.query.teachingOrders.findFirst({
    where: eq(teachingOrders.id, orderId),
  });
  if (!order || order.status !== "pending") return "already";

  if (payment.amountCents !== order.amountCents) {
    console.error(
      `[TEACHINGS] amount mismatch on order ${order.id}: paid ${payment.amountCents} cents, expected ${order.amountCents} (payment ${payment.paymentId}). Not finalized.`,
    );
    return "amount_mismatch";
  }

  const grantCreated = await db.transaction(async (tx) => {
    const won = await tx
      .update(teachingOrders)
      .set({
        status: "paid",
        paidAt: new Date(),
        method: payment.method ?? null,
        easypayPaymentId: payment.paymentId,
      })
      .where(and(eq(teachingOrders.id, order.id), eq(teachingOrders.status, "pending")))
      .returning({ id: teachingOrders.id });
    if (won.length === 0) return null;

    const granted = await tx
      .insert(eventAccessGrants)
      .values({
        userId: order.userId,
        eventId: order.eventId,
        source: "purchase",
        orderId: order.id,
      })
      .onConflictDoNothing()
      .returning({ userId: eventAccessGrants.userId });
    return granted.length > 0;
  });

  if (grantCreated === null) return "already";

  // Past the commit: neither of these may fail the notification, or Easypay retries into "already".
  try {
    if (grantCreated) await bumpUserAccessVersion(order.userId);
  } catch (err) {
    console.error(`[TEACHINGS] could not bump access version for user ${order.userId}:`, err);
  }
  await sendTeachingAvailableEmail(order);
  return "finalized";
}

/** Best-effort "your recordings" email for an order or a free claim: never throws. */
export async function sendTeachingAvailableEmail(
  order: Pick<TeachingOrder, "eventId" | "email" | "firstName" | "language"> & { id?: number },
): Promise<void> {
  try {
    const event = await db.query.events.findFirst({ where: (e, { eq }) => eq(e.id, order.eventId) });
    if (!event) return;
    const lang = order.language === "pt" ? "pt" : "en";
    const title =
      (lang === "pt" ? event.titlePt || event.titleEn : event.titleEn || event.titlePt) ||
      `Event ${event.id}`;
    const mail = buildTeachingAvailableEmail({
      lang,
      firstName: order.firstName,
      eventTitle: title,
      published: event.status === "published",
    });
    await sendEmail({ to: order.email, ...mail });
  } catch (err) {
    console.error(`[TEACHINGS] could not send access email for ${order.id === undefined ? `free claim of event ${order.eventId}` : `order ${order.id}`}:`, err);
  }
}

// ─── Easypay reads ───
//
// Field names below were confirmed against docs.easypay.pt (Context7 /websites/easypay_pt):
//   GET /checkout/{id} -> { checkout: { id, status }, payment: { id, status, ... }, value }
//   GET /single/{id}   -> { id, key, value (euros), currency, method: { type, status,
//                         entity?, reference? }, payment_status, created_at, captures[] }
//   payment_status: pending | paid | authorised | error | deleted | failed | active | voided
// Not observed on a real sandbox call yet: whether `key` echoes the checkout's `payment.key`.

interface EasypayCheckoutDetails {
  checkout?: { id?: string; status?: string };
  payment?: { id?: string; status?: string };
}

interface EasypaySingleResponse {
  id?: string;
  key?: string;
  value?: number;
  payment_status?: string;
  method?: { type?: string; status?: string; entity?: string; reference?: string };
}

export interface SinglePaymentInfo {
  paymentId: string;
  status: string;
  key: string | null;
  amountCents: number | null;
  methodType: string | null;
  entity: string | null;
  reference: string | null;
}

/**
 * checkout -> single payment, as one normalised record. Null when there is
 * nothing to read yet (mock mode, no checkout, customer has not chosen a method)
 * or Easypay cannot be reached: callers treat "unknown" as "still pending".
 */
export async function lookupSinglePayment(
  order: Pick<TeachingOrder, "id" | "easypayCheckoutId" | "easypayPaymentId">,
): Promise<SinglePaymentInfo | null> {
  if (isMockMode) return null;
  try {
    let paymentId = order.easypayPaymentId;
    if (!paymentId) {
      if (!order.easypayCheckoutId) return null;
      const checkout = await easypayFetch<EasypayCheckoutDetails>(
        `/checkout/${encodeURIComponent(order.easypayCheckoutId)}`,
      );
      paymentId = checkout.payment?.id ?? null;
      if (!paymentId) return null;
    }
    return await readSingle(paymentId);
  } catch (err) {
    console.error(`[TEACHINGS] could not read Easypay payment for order ${order.id}:`, err);
    return null;
  }
}

async function readSingle(paymentId: string): Promise<SinglePaymentInfo> {
  const single = await easypayFetch<EasypaySingleResponse>(`/single/${encodeURIComponent(paymentId)}`);
  return {
    paymentId,
    status: (single.payment_status ?? "").toLowerCase(),
    key: single.key ?? null,
    amountCents: typeof single.value === "number" ? Math.round(single.value * 100) : null,
    methodType: single.method?.type ?? null,
    entity: single.method?.entity ?? null,
    reference: single.method?.reference ?? null,
  };
}

/**
 * Webhook probe: is this notification id a single payment? Null when Easypay says it is
 * not (a 4xx, e.g. 404: the id belongs to something else). THROWS when the answer is
 * unknown (network error or Easypay 5xx), so the webhook can ask Easypay to retry
 * instead of recording the notification as unverified.
 */
export async function probeSinglePayment(paymentId: string): Promise<SinglePaymentInfo | null> {
  if (isMockMode) return null;
  try {
    return await readSingle(paymentId);
  } catch (err) {
    if (err instanceof EasypayHttpError && err.easypayStatus < 500) return null;
    throw err;
  }
}

export type RefreshResult = FinalizeResult | "unknown" | "key_mismatch" | "no_amount" | "failed" | "expired" | "pending";

const FAILED_STATUSES = new Set(["failed", "error", "voided"]);

/**
 * Re-read a pending order from Easypay and finalize it when paid, so the
 * confirmation page does not depend on the webhook alone. Pass `info` when the
 * caller already looked the payment up.
 */
export async function refreshOrderFromEasypay(
  order: TeachingOrder,
  info?: SinglePaymentInfo | null,
): Promise<RefreshResult> {
  const payment = info === undefined ? await lookupSinglePayment(order) : info;
  if (!payment) return "unknown";

  if (payment.key !== null && payment.key !== teachingOrderKey(order.publicId)) {
    console.error(
      `[TEACHINGS] payment ${payment.paymentId} has key ${payment.key}, not ${teachingOrderKey(order.publicId)}; ignored.`,
    );
    return "key_mismatch";
  }

  if (payment.status === "paid") {
    if (payment.amountCents === null) {
      console.error(`[TEACHINGS] paid payment ${payment.paymentId} has no readable value; order ${order.id} not finalized.`);
      return "no_amount";
    }
    return finalizeOrder(order.id, {
      paymentId: payment.paymentId,
      method: payment.methodType?.toLowerCase(),
      amountCents: payment.amountCents,
    });
  }

  const next = FAILED_STATUSES.has(payment.status) ? "failed" : payment.status === "deleted" ? "expired" : null;
  if (next) {
    await db
      .update(teachingOrders)
      .set({ status: next, easypayPaymentId: payment.paymentId })
      .where(and(eq(teachingOrders.id, order.id), eq(teachingOrders.status, "pending")));
  }
  return next ?? "pending";
}
