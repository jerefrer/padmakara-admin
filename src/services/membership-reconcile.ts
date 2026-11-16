import { and, eq, gt, gte, isNotNull, isNull, like, not, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { paymentTransactions } from "../db/schema/payment-transactions.ts";
import {
  creditNewCaptures,
  easypayFetch,
  EasypayHttpError,
  isMockMode,
  resolveUserId,
  SUBSCRIPTION_NOT_FOUND_NOTE,
  type EasypaySubscriptionResponse,
} from "../routes/payment.ts";

/**
 * Periodic safety net for membership payments: reads each live Easypay subscription back
 * and credits any capture that is paid and not yet counted, through the same
 * `creditNewCaptures` the webhook uses. A notification that never arrived (or that we had
 * to drop) is counted here instead of being lost; one already credited is not counted
 * again, because a capture is credited at most once by its Easypay id.
 *
 * Read-only towards Easypay (GET only, apart from the deactivation `creditNewCaptures`
 * may do when a capture swaps in a new subscription, exactly as the webhook would).
 */

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
/** A member whose access ended longer ago than this is not read back (nothing charges them). */
const LAPSED_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/** How long a notification that Easypay answered 404 for keeps being read again. */
const NOT_FOUND_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;

export interface ReconcileResult {
  checked: number;
  credited: number;
  errors: number;
}

/** Read one subscription and credit what is new for `expectedUserId` (any user when null). */
async function reconcileSubscription(
  subscriptionId: string,
  expectedUserId: number | null,
  result: ReconcileResult,
): Promise<void> {
  result.checked++;
  let subscription: EasypaySubscriptionResponse;
  try {
    subscription = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(subscriptionId)}`);
  } catch (err) {
    // An unknown id stays unknown until it shows up; anything else is worth a log line.
    if (!(err instanceof EasypayHttpError && err.easypayStatus === 404 && expectedUserId === null)) {
      console.error(`[EASYPAY RECONCILE] could not read subscription ${subscriptionId}:`, err);
      result.errors++;
    }
    return;
  }
  const userId = resolveUserId(subscription);
  if (userId === null || (expectedUserId !== null && userId !== expectedUserId)) {
    // Never credit one member from a subscription Easypay attributes to someone else.
    console.error(
      `[EASYPAY RECONCILE] subscription ${subscriptionId} belongs to ${JSON.stringify(subscription.customer?.key)}, expected user ${expectedUserId ?? "user-{id}"} — skipped`,
    );
    result.errors++;
    return;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return;
  const outcome = await creditNewCaptures(user, subscriptionId, subscription, "reconcile");
  if (outcome.credited.length > 0) {
    result.credited += outcome.credited.length;
    console.warn(
      `[EASYPAY RECONCILE] credited ${outcome.credited.join(", ")} to user ${userId} from ${subscriptionId} — its notification never counted it`,
    );
  }
}

/** One pass over the live Easypay members, then over recent notifications Easypay answered 404 for. */
export async function reconcileMemberships(now: Date = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, credited: 0, errors: 0 };
  if (isMockMode) return result;

  const members = await db
    .select({ id: users.id, easypaySubscriptionId: users.easypaySubscriptionId })
    .from(users)
    .where(
      and(
        eq(users.subscriptionSource, "easypay"),
        isNotNull(users.easypaySubscriptionId),
        not(like(users.easypaySubscriptionId, "mock\\_%")),
        or(isNull(users.subscriptionCancelledAt), gt(users.subscriptionExpiresAt, new Date(now.getTime() - LAPSED_WINDOW_MS))),
      ),
    )
    .orderBy(users.id)
    .limit(10_000);

  for (const member of members) {
    if (!member.easypaySubscriptionId) continue;
    try {
      await reconcileSubscription(member.easypaySubscriptionId, member.id, result);
    } catch (err) {
      result.errors++;
      console.error(`[EASYPAY RECONCILE] user ${member.id} failed:`, err);
    }
  }

  // A capture notification Easypay answered 404 for may have been ahead of Easypay's own
  // records (one such row exists in production). Read those ids again for two weeks.
  const notFound = await db
    .selectDistinct({ notificationId: paymentTransactions.notificationId })
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.action, "unverified"),
        eq(paymentTransactions.note, SUBSCRIPTION_NOT_FOUND_NOTE),
        like(paymentTransactions.notificationType, "subscription%"),
        gte(paymentTransactions.createdAt, new Date(now.getTime() - NOT_FOUND_RECHECK_MS)),
      ),
    )
    .limit(1000);
  const memberSubscriptions = new Set(members.map((m) => m.easypaySubscriptionId?.toLowerCase()));
  for (const { notificationId } of notFound) {
    if (memberSubscriptions.has(notificationId.toLowerCase())) continue;
    try {
      await reconcileSubscription(notificationId, null, result);
    } catch (err) {
      result.errors++;
      console.error(`[EASYPAY RECONCILE] notification ${notificationId} failed:`, err);
    }
  }

  console.log(
    `[EASYPAY RECONCILE] checked ${result.checked} subscriptions, credited ${result.credited} captures, ${result.errors} errors`,
  );
  return result;
}

let running = false;

/** First pass a few minutes after start, then hourly. The timers never keep the process alive. */
export function startMembershipReconcile(): void {
  if (isMockMode) return;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileMemberships();
    } catch (err) {
      console.error("[EASYPAY RECONCILE] run failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref();
  setInterval(() => void run(), RECONCILE_INTERVAL_MS).unref();
}
