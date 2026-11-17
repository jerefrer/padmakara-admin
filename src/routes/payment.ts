import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, and, or, inArray, desc, gte, ne, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { paymentTransactions } from "../db/schema/payment-transactions.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { hasActiveSubscription } from "../services/access.ts";
import { sendEmail } from "../services/email.ts";
import {
  buildWelcomeEmail,
  buildPaymentFailedEmail,
  buildCancelledEmail,
  buildFirstPaymentFailedEmail,
  emailLanguage,
} from "../services/membership-emails.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { authIpLimiter } from "../middleware/rate-limit.ts";
import {
  parseContribution,
  frequencyFor,
  intervalFromFrequency,
  addInterval,
  easypayDateTime,
  type MembershipInterval,
} from "../services/membership.ts";
import {
  CHARGEBACK_APPLIED,
  CREDIT_ACTIONS,
  REFUND_APPLIED,
  REVERSAL_APPLIED_ACTIONS,
  easypayTime,
  expiryAfterCapture,
  expiryAfterRefund,
  listCaptures,
  uncountedPaidCaptures,
} from "../services/membership-captures.ts";
import { teachingOrders } from "../db/schema/event-access.ts";
import {
  probeSinglePayment,
  paymentBelongsToOrder,
  refreshOrderFromEasypay,
  reverseTeachingOrder,
} from "../services/teaching-orders.ts";

const EASYPAY_API_BASE = config.easypay.testing
  ? "https://api.test.easypay.pt/2.0"
  : "https://api.prod.easypay.pt/2.0";

/** Largest webhook body accepted; a real Easypay notification is far smaller. */
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Easypay resource ids (subscription, single payment, checkout): checked against every id stored in production on 2026-11-16 (54 of 54). */
const EASYPAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EASYPAY_CHECKOUT_SDK = "https://cdn.easypay.pt/checkout/2.9.1/";

export const isMockMode = !config.easypay.accountId;

if (isMockMode) {
  console.log(
    "[PAYMENT] Mock mode enabled — no EASYPAY_ACCOUNT_ID configured. Subscribe/cancel will work without Easypay.",
  );
}

// ─── Easypay API response shapes ───

/** Shape of the Easypay POST /checkout response we use. */
interface EasypayCheckoutResponse {
  id: string;
  session: string;
  [key: string]: unknown;
}

/**
 * Shape of the Easypay `GET /subscription/:id` response we use.
 *
 * Verified against the live sandbox API on 2026-07-30. Two things this response does
 * NOT contain, despite earlier code assuming otherwise: there is no `order` object,
 * and there is no top-level `status`. The user id travels in `customer.key`; the
 * mandate/method state is `method.status` — which is not the same thing as the money
 * having arrived, so it must not be used to grant access. Money is read from
 * `transactions` (see `src/services/membership-captures.ts`).
 */
export interface EasypaySubscriptionResponse {
  id?: string;
  key?: string;
  frequency?: string;
  value?: number;
  currency?: string;
  customer?: { key?: string; email?: string; [key: string]: unknown };
  method?: { type?: string; status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ─── Notification handling ───

/**
 * Easypay generic notifications carry `{id, key, type, status, messages, date}`.
 *
 * The body is unauthenticated, so its `type` and `status` are hints and nothing more:
 * they decide which Easypay resource to read and what to log, never whether money
 * arrived or went back. Access is extended from the captures Easypay lists on the
 * subscription (`creditNewCaptures`) and shortened or closed only on a refund or chargeback
 * that Easypay itself reports on a capture we credited (`verifyReversal`). The one thing a
 * hint still drives on its own is the "payment failed" email and page state, which
 * change no access.
 */
// "subscription_capture" is the type Easypay actually sent for a monthly charge — first
// observed live on 2026-08-09 / 2026-09-09 (see payment_transactions id 1). Without it a
// successful renewal would have been stored and ignored, never extending access.
const PAYMENT_TYPES = new Set(["subscription_capture", "capture", "payment", "subscription"]);
const REVERSAL_TYPES = new Set(["refund", "void", "chargeback", "dispute"]);
const SUCCESS_STATUSES = new Set(["success", "paid", "active", "completed"]);

type NotificationKind = "payment" | "payment_failed" | "reversal" | "unknown";

/** The `key` of a teaching order's Easypay payment; see `teachingOrderKey`. */
const TEACHING_ORDER_KEY = /^teaching-order-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function classifyNotification(
  type: string | null,
  status: string | null,
): NotificationKind {
  const t = (type ?? "").toLowerCase();
  const s = (status ?? "").toLowerCase();
  if (REVERSAL_TYPES.has(t)) return "reversal";
  if (PAYMENT_TYPES.has(t)) {
    return SUCCESS_STATUSES.has(s) ? "payment" : "payment_failed";
  }
  return "unknown";
}

/**
 * The user id lives in `customer.key` (`user-{id}`, set when we create the checkout).
 *
 * We deliberately do not fall back to any value taken from the request body. This
 * endpoint is unauthenticated, so a caller-supplied key would let anyone activate any
 * account — and since the subscription resource has no `order.key` and its own `key`
 * came back empty, that fallback was previously the *only* code path, not an edge case.
 */
export function resolveUserId(subscription: EasypaySubscriptionResponse): number | null {
  const match = /^user-(\d+)$/.exec(subscription.customer?.key ?? "");
  return match ? parseInt(match[1]!, 10) : null;
}

// ─── Easypay API helpers ───

/**
 * An Easypay answer that was not 2xx. It is an AppError.internal to every caller that does
 * not look (so they behave as before: a 500 to our client), but carries Easypay's own status
 * for the few that must tell "refused, 4xx" from "unreachable or broken, 5xx".
 */
export class EasypayHttpError extends AppError {
  constructor(public readonly easypayStatus: number) {
    super(500, `Easypay API error: ${easypayStatus}`, "INTERNAL_ERROR");
    this.name = "EasypayHttpError";
  }
}

export async function easypayFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${EASYPAY_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      AccountId: config.easypay.accountId,
      ApiKey: config.easypay.apiKey,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Easypay API error ${res.status}: ${body}`);
    throw new EasypayHttpError(res.status);
  }
  return res.json() as Promise<T>;
}

// ─── Mock mode helpers ───

function mockCreateSubscription(userId: number, amount: number, interval: MembershipInterval) {
  const expiresAt = addInterval(new Date(), interval);
  return db
    .update(users)
    .set({
      subscriptionStatus: "active",
      subscriptionSource: "easypay",
      easypaySubscriptionId: `mock_sub_${userId}`,
      subscriptionExpiresAt: expiresAt,
      subscriptionAmount: String(amount),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * Mirrors the real cancel: the member keeps access until the period they already paid
 * for runs out, so this marks the cancellation rather than expiring the subscription.
 */
function mockCancelSubscription(userId: number) {
  return db
    .update(users)
    .set({
      subscriptionCancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

// ─── Membership read model ───

export interface MembershipView {
  state: "none" | "active" | "cancelled" | "payment_failed" | "lapsed" | "processing";
  source: "easypay" | "admin" | "cash" | "bank_transfer" | null;
  amount: number | null;
  interval: MembershipInterval | null;
  accessUntil: string | null;
  graceUntil: string | null;
  cancelledAt: string | null;
  method: { type: "card" | "direct_debit"; lastFour: string | null; brand: string | null } | null;
  history: { date: string; amount: number | null; outcome: "paid" | "failed" | "refunded" }[];
  /** A first payment (no access yet) failed within the last 14 days and has not been retried. */
  lastPaymentFailedAt: string | null;
}

/** Ledger notification types that describe a charge attempt (not card storage). */
const CAPTURE_TYPES = ["subscription_capture", "capture"];
const HISTORY_LIMIT = 12;

/**
 * Ledger row `subscribe` writes when it creates a checkout. Direct Debit sends no
 * subscription_create, and a checkout can sit at the bank for days with no notification at
 * all, so this is the only trace that a first payment is under way.
 */
const CHECKOUT_TYPE = "checkout";
/** Ledger types that say where a first payment stands; the newest one decides. */
const PROGRESS_TYPES = [CHECKOUT_TYPE, "subscription_create", ...CAPTURE_TYPES];
/** How long a first payment may stay "in flight" / "failed" before we stop talking about it. */
const FIRST_PAYMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface LedgerRow {
  notificationType: string | null;
  notificationId: string;
  action: string;
  note: string | null;
  createdAt: Date;
}

/**
 * Ledger action of a capture notification after which Easypay listed no new paid capture:
 * the body claimed a payment that is not (or not yet) there. It records what was received
 * and says nothing about where a payment stands, so the read model skips it — a forged or
 * early notification must not end a Direct Debit's "processing" state or hide a failure.
 */
const NO_NEW_CAPTURE = "no_new_capture";

/**
 * Ledger action of a subscription_create whose subscription Easypay does not report as one
 * just created and live (see `adoptionRefusal`): recorded for a human, skipped by the read
 * model for the same reason as {@link NO_NEW_CAPTURE}.
 */
const CREATE_NOT_ADOPTED = "create_not_adopted";

/** Ledger actions that only record what was received and say nothing about a payment. */
const RECORD_ONLY_ACTIONS = new Set([NO_NEW_CAPTURE, CREATE_NOT_ADOPTED]);

/** Note on an `unverified` row whose subscription Easypay answered 404 for; the reconcile job reads these again. */
export const SUBSCRIPTION_NOT_FOUND_NOTE = "subscription not found at Easypay (404)";

/** A capture-type row that describes a charge attempt (not one only recorded for a human). */
const isChargeRow = (r: { notificationType: string | null; action: string }) =>
  CAPTURE_TYPES.includes(r.notificationType ?? "") && !RECORD_ONLY_ACTIONS.has(r.action);

const newestProgressRow = <T extends { notificationType: string | null; action: string }>(rows: T[]): T | undefined =>
  rows.find((r) => PROGRESS_TYPES.includes(r.notificationType ?? "") && !RECORD_ONLY_ACTIONS.has(r.action));

const isRecent = (at: Date) => Date.now() - at.getTime() <= FIRST_PAYMENT_WINDOW_MS;

/** Ledger rows for the first-payment checks, newest first. */
async function loadProgressRows(userId: number): Promise<LedgerRow[]> {
  return db
    .select({
      notificationType: paymentTransactions.notificationType,
      notificationId: paymentTransactions.notificationId,
      action: paymentTransactions.action,
      note: paymentTransactions.note,
      createdAt: paymentTransactions.createdAt,
    })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.userId, userId), inArray(paymentTransactions.notificationType, PROGRESS_TYPES)))
    .orderBy(desc(paymentTransactions.createdAt))
    .limit(50);
}

/**
 * True while a first payment is at the bank: the member has no access, the newest sign of
 * life in the ledger is the checkout we created (within 14 days), and Easypay says that
 * checkout is a Direct Debit that has not failed. An abandoned card checkout is not
 * processing. Any Easypay error fails open (not processing) so nobody is locked out of paying.
 * `rows` is newest first.
 */
async function isFirstPaymentProcessing(
  user: { subscriptionStatus: string; subscriptionExpiresAt: Date | null; subscriptionCancelledAt: Date | null },
  rows: Array<Pick<LedgerRow, "notificationType" | "notificationId" | "action" | "createdAt">>,
): Promise<boolean> {
  if (hasActiveSubscription(user)) return false;
  const newest = newestProgressRow(rows);
  if (!newest || newest.notificationType !== CHECKOUT_TYPE || newest.action !== "checkout_created") return false;
  if (!isRecent(newest.createdAt)) return false;
  try {
    const checkout = await easypayFetch<{
      payment?: { status?: string; method?: { type?: string } };
      method?: { type?: string };
    }>(`/checkout/${encodeURIComponent(newest.notificationId)}`);
    const method = methodKind(checkout.method?.type ?? checkout.payment?.method?.type);
    const status = (checkout.payment?.status ?? "").toLowerCase();
    return method === "direct_debit" && !["failed", "error", "deleted"].includes(status);
  } catch (err) {
    console.error(`[MEMBERSHIP] could not read Easypay checkout ${newest.notificationId}:`, err);
    return false;
  }
}

/**
 * Whether this Easypay subscription has ever been charged successfully. A failure on a
 * subscription that was never paid is a first payment (a new or returning member); a
 * failure on one that was paid before is a renewal, even after access has lapsed.
 */
async function hasBeenPaidBefore(subscriptionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.notificationId, subscriptionId),
        inArray(paymentTransactions.action, ["activated", "extended"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const FAILURE_EMAIL_WINDOW_DAYS = 7;

/**
 * Whether another `payment_failed` row for this subscription (not the one being processed,
 * `currentTxId`) was recorded in the last {@link FAILURE_EMAIL_WINDOW_DAYS} days, which means
 * the member was already emailed about this failure.
 */
async function alreadyToldAboutFailure(subscriptionId: string, currentTxId: number): Promise<boolean> {
  const since = new Date(Date.now() - FAILURE_EMAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.notificationId, subscriptionId),
        eq(paymentTransactions.note, "payment_failed"),
        gte(paymentTransactions.createdAt, since),
        ne(paymentTransactions.id, currentTxId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** ISO time of a first-payment failure the member has not retried yet, else null. */
function firstPaymentFailedAt(
  user: { subscriptionStatus: string; subscriptionExpiresAt: Date | null; subscriptionCancelledAt: Date | null },
  rows: Array<Pick<LedgerRow, "notificationType" | "action" | "note" | "createdAt">>,
): string | null {
  if (hasActiveSubscription(user)) return null;
  const newest = newestProgressRow(rows);
  if (
    newest &&
    CAPTURE_TYPES.includes(newest.notificationType ?? "") &&
    newest.action === "ignored" &&
    newest.note === "payment_failed" &&
    isRecent(newest.createdAt)
  ) {
    return newest.createdAt.toISOString();
  }
  return null;
}

/**
 * Where the member stands. `lastCapture` is the newest capture row in the ledger: a
 * failed charge only matters while access is still running, since a lapsed member is
 * simply lapsed whatever the last charge did.
 */
export function membershipState(
  user: {
    subscriptionStatus: string;
    subscriptionExpiresAt: Date | null;
    subscriptionCancelledAt: Date | null;
  },
  lastCapture: { action: string; note: string | null } | null,
  processing = false,
): MembershipView["state"] {
  if (processing) return "processing";
  if (user.subscriptionStatus === "none" && !user.subscriptionExpiresAt) return "none";
  if (!hasActiveSubscription(user)) return "lapsed";
  if (user.subscriptionCancelledAt) return "cancelled";
  if (lastCapture?.action === "ignored" && lastCapture.note === "payment_failed") return "payment_failed";
  return "active";
}

function methodKind(type: unknown): "card" | "direct_debit" | null {
  const t = typeof type === "string" ? type.toLowerCase() : "";
  if (t === "cc") return "card";
  if (t === "dd") return "direct_debit";
  return null;
}

function historyOutcome(action: string, note: string | null): "paid" | "failed" | "refunded" | null {
  if (action === "activated" || action === "extended") return "paid";
  if (action === "ignored" && note === "payment_failed") return "failed";
  if (action === "reversed" || action === REFUND_APPLIED || action === CHARGEBACK_APPLIED) return "refunded";
  return null;
}

/** Last day of the grace window after a paid-through date. */
function graceEnd(expiresAt: Date): Date {
  const g = new Date(expiresAt);
  g.setDate(g.getDate() + config.subscription.graceDays);
  return g;
}

/**
 * Fire-and-forget: a mail failure (sync or async) must never change the HTTP answer, least
 * of all to Easypay, which would retry the whole notification.
 */
function sendMembershipEmail(to: string, build: () => { subject: string; html: string; text: string }): void {
  try {
    const { subject, html, text } = build();
    Promise.resolve(sendEmail({ to, subject, html, text })).catch((err) =>
      console.error(`[MEMBERSHIP EMAIL] could not send "${subject}" to ${to}:`, err),
    );
  } catch (err) {
    console.error(`[MEMBERSHIP EMAIL] could not send to ${to}:`, err);
  }
}

function sendCancelledEmail(user: {
  email: string;
  firstName: string | null;
  preferredLanguage: string | null;
  subscriptionExpiresAt: Date | null;
}): void {
  const accessUntil = user.subscriptionExpiresAt;
  if (!accessUntil) return;
  sendMembershipEmail(user.email, () =>
    buildCancelledEmail({
      lang: emailLanguage(user.preferredLanguage),
      firstName: user.firstName,
      accessUntil,
      resumeUrl: membershipUrl(),
    }),
  );
}

const membershipUrl = () => `${config.urls.frontend}/membership`;

// ─── Which Easypay subscription is the member's ───

/**
 * How a stop at Easypay went. Only a 404 means the subscription is gone, so there is
 * nothing left to stop and retrying would loop forever. Stopping an already inactive
 * subscription is not an error at Easypay (it answers "ok" — observed in the sandbox on
 * 2026-10-07), so any other 4xx (bad credentials, a malformed request) is a real failure:
 * treating it as stopped would leave the old card charging. Those, network errors and
 * 5xx are retried.
 */
export type StopResult = "stopped" | "already_inactive" | "failed";

/** Ledger note suffix describing a stop; empty when it simply worked. */
const stopSuffix = (r: StopResult) =>
  r === "failed" ? "; deactivation failed" : r === "already_inactive" ? "; deactivation: already inactive" : "";

/**
 * Ledger notes that mark `id` as a subscription that must never become the stored one:
 * `replaced <id>` (a newer one took over) and `discarded <id>` (it arrived for a cancelled
 * member, or older than the one already stored, and was stopped at once), each with every
 * suffix {@link stopSuffix} can add.
 */
const replacedNotes = (id: string) =>
  (["replaced", "discarded"] as const).flatMap((verb) =>
    (["stopped", "already_inactive", "failed"] as const).map((r) => `${verb} ${id}${stopSuffix(r)}`),
  );

async function wasReplaced(userId: number, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.userId, userId), inArray(paymentTransactions.note, replacedNotes(id))))
    .limit(1);
  return rows.length > 0;
}

export async function deactivateAtEasypay(id: string): Promise<StopResult> {
  try {
    await easypayFetch(`/subscription/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "inactive" }) });
    return "stopped";
  } catch (err) {
    if (err instanceof EasypayHttpError && err.easypayStatus === 404) {
      console.warn(
        `[EASYPAY WEBHOOK] Easypay answered ${err.easypayStatus} to stopping subscription ${id} — treating it as gone`,
      );
      return "already_inactive";
    }
    console.error(`[EASYPAY WEBHOOK] could not deactivate subscription ${id}:`, err);
    return "failed";
  }
}

/**
 * Whether `incoming` is older than the stored subscription `storedId`. Two timestamps in the
 * same format compare fine whatever their zone. Fails open (false: adopt) when either date
 * is missing or the stored one cannot be read, since keeping a card update out is worse than
 * the rare out-of-order pair this guards against.
 *
 * `strict` (subscription_create, where no money vouches for the incoming subscription): only
 * a 404 on the stored one counts as "gone, adopt"; any other failed read THROWS, so the
 * webhook answers 503 and Easypay retries instead of the stored subscription being stopped
 * on a comparison that was never made.
 */
async function isOlderThanStored(
  incoming: EasypaySubscriptionResponse,
  storedId: string,
  strict = false,
): Promise<boolean> {
  const incomingAt = easypayTime(incoming.created_at);
  if (incomingAt === null) return false;
  try {
    const stored = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(storedId)}`);
    const storedAt = easypayTime(stored.created_at);
    return storedAt !== null && incomingAt < storedAt;
  } catch (err) {
    if (strict && !(err instanceof EasypayHttpError && err.easypayStatus === 404)) throw err;
    console.error(`[EASYPAY WEBHOOK] could not read stored subscription ${storedId} to compare ages:`, err);
    return false;
  }
}

/**
 * How long after Easypay created a subscription its subscription_create may still make it the
 * member's. A real one arrives within a minute of the card being stored; the margin covers
 * Easypay's retries and our own 503s. Past it, a subscription is adopted only by a paid capture.
 */
const CREATE_ADOPTION_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Tolerated clock difference for a `created_at` slightly ahead of ours. */
const CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Why a subscription_create must not drive adoption, judged only on what Easypay reports about
 * the subscription (never on the notification body): null when Easypay says it was created
 * within {@link CREATE_ADOPTION_WINDOW_MS} and its payment method is not inactive.
 *
 * A subscription_create carries no money, so the body's `type` and `status` are no evidence
 * that a card was just stored. Without this, anyone holding one of a member's subscription
 * ids could post a create for it: an old one would be swapped in and the live one stopped, or
 * (for a cancelled member) the one posted would be stopped. With it, the most a forged or
 * replayed create can do is what the real notification of a subscription Easypay created in
 * the last few days would do anyway.
 */
function adoptionRefusal(subscription: EasypaySubscriptionResponse, now: Date = new Date()): string | null {
  const methodStatus = typeof subscription.method?.status === "string" ? subscription.method.status.toLowerCase() : "";
  if (methodStatus === "inactive") return "Easypay reports its payment method inactive";
  const createdAt = easypayTime(subscription.created_at);
  if (createdAt === null) return "Easypay gives no created_at";
  if (createdAt > now.getTime() + CREATED_AT_SKEW_MS) return `created_at ${String(subscription.created_at)} is in the future`;
  if (now.getTime() - createdAt > CREATE_ADOPTION_WINDOW_MS) {
    return `created ${String(subscription.created_at)}, more than ${CREATE_ADOPTION_WINDOW_MS / 3_600_000} h ago`;
  }
  return null;
}

type Adoption =
  /** `id` is already the stored subscription. */
  | { outcome: "current" }
  /** `id` was replaced earlier; it must never become the stored one again. */
  | { outcome: "stale" }
  /**
   * `id` must not become the stored one and has been stopped (`stop` says how it went):
   * `cancelled` — the member cancelled and still has access, so a new subscription would
   * charge someone who left; `older` — a newer one is already stored.
   */
  | { outcome: "discard"; reason: "cancelled" | "older"; stop: StopResult }
  /**
   * `id` becomes the member's subscription: write `fields`. `previous` is the one it
   * replaces; `stop` is how stopping it went ("failed": Easypay did not confirm).
   */
  | {
      outcome: "adopt";
      previous: string | null;
      stop: StopResult;
      fields: { easypaySubscriptionId: string; subscriptionCancelledAt: null };
    };

/**
 * Decide what a notification about subscription `id` means for the member's stored one,
 * and stop whichever of the two must not charge. Shared by subscription_create and the
 * capture branch because Easypay does not promise their order: a capture can arrive before
 * (or without) its create, and a late notification can concern a subscription already replaced.
 *
 * Writes nothing to the user row: the caller does, so a caller that must fail (and have
 * Easypay retry) can still do so with the user untouched.
 *
 * `strict` is for subscription_create (see {@link isOlderThanStored}); the capture path is
 * vouched for by money Easypay lists on `id` and keeps failing open.
 */
async function adoptSubscription(
  user: {
    id: number;
    easypaySubscriptionId: string | null;
    subscriptionCancelledAt: Date | null;
    subscriptionStatus: string;
    subscriptionExpiresAt: Date | null;
  },
  id: string,
  incoming: EasypaySubscriptionResponse,
  { strict = false }: { strict?: boolean } = {},
): Promise<Adoption> {
  const previous = user.easypaySubscriptionId ?? null;
  if (previous === id) return { outcome: "current" };

  if (await wasReplaced(user.id, id)) {
    console.error(
      `[EASYPAY WEBHOOK] notification for ${id}, which user ${user.id} replaced with ${previous ?? "nothing"} — keeping ${previous ?? "nothing"}, stopping ${id} again`,
    );
    // It should not be charging at all. Stopping it again is harmless if it is already inactive.
    await deactivateAtEasypay(id);
    return { outcome: "stale" };
  }

  // A mock id has nothing at Easypay to stop or compare with.
  const hasRealPrevious = previous !== null && !previous.startsWith("mock_");

  // A member who cancelled and still has access is not paying through anything new: a
  // card update they started before cancelling must not bring the charges back. (Once
  // access has ended, a new subscription is them joining again and is adopted.)
  if (hasRealPrevious && user.subscriptionCancelledAt && hasActiveSubscription(user)) {
    console.error(
      `[EASYPAY WEBHOOK] ${id} arrived for user ${user.id}, who cancelled — stopping ${id}, keeping the cancellation`,
    );
    return { outcome: "discard", reason: "cancelled", stop: await deactivateAtEasypay(id) };
  }

  // A cancellation already stopped the previous one at Easypay (/cancel PATCHes before it
  // records subscriptionCancelledAt), so only a member who has not cancelled has a live one.
  const needsStop = hasRealPrevious && !user.subscriptionCancelledAt;

  // Two card updates can complete in either order; the newer card is the one to keep.
  if (needsStop && (await isOlderThanStored(incoming, previous, strict))) {
    console.error(`[EASYPAY WEBHOOK] ${id} is older than user ${user.id}'s stored ${previous} — stopping ${id}`);
    return { outcome: "discard", reason: "older", stop: await deactivateAtEasypay(id) };
  }

  const stop: StopResult = needsStop ? await deactivateAtEasypay(previous) : "stopped";
  return {
    outcome: "adopt",
    previous,
    stop,
    fields: { easypaySubscriptionId: id, subscriptionCancelledAt: null },
  };
}

// ─── Crediting captures ───

/**
 * Whether a refund on `subscriptionId` was applied to this member (its ledger note names the
 * subscription). Such a member's subscription kept running at Easypay, so a capture that
 * restores their access is the same membership carrying on, not someone joining: no welcome.
 * A read failure answers false, which only means the welcome is sent as it was before.
 */
async function refundEndedAccessOn(userId: number, subscriptionId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: paymentTransactions.id })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.userId, userId),
          eq(paymentTransactions.action, REFUND_APPLIED),
          sql`${paymentTransactions.note} ilike ${`%(${subscriptionId.toLowerCase()})%`}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.error(`[EASYPAY CREDIT] could not read the refunds of ${subscriptionId}:`, err);
    return false;
  }
}

type MemberRow = typeof users.$inferSelect;

export interface CreditOutcome {
  /** Easypay capture ids credited by this call, oldest first. */
  credited: string[];
  /** The paid-through date after the last of them; null when nothing was credited. */
  expiresAt: Date | null;
}

/**
 * Credit every capture of `subscriptionId` that Easypay reports paid and the ledger has not
 * counted yet, one interval each: the only way Easypay money extends access. The webhook
 * runs it on every subscription notification and the reconcile job on every live member,
 * so a forged or replayed notification finds nothing new, and a lost one is caught later.
 *
 * Each capture is credited in one transaction: the member row is locked, the new expiry is
 * computed from what the lock read, and the credit row is inserted under the unique
 * `easypay_transaction_id`. Two notifications (or a notification and the reconcile job)
 * racing for the same capture: one inserts, the other conflicts and changes nothing. Two
 * captures for one member: the lock serialises them, so neither overwrites the other.
 *
 * Throws on a database error, so the webhook can give its claim back and have Easypay retry.
 */
export async function creditNewCaptures(
  user: MemberRow,
  subscriptionId: string,
  subscription: EasypaySubscriptionResponse,
  source: "webhook" | "reconcile",
): Promise<CreditOutcome> {
  const ledger = await db
    .select({
      action: paymentTransactions.action,
      easypayTransactionId: paymentTransactions.easypayTransactionId,
      createdAt: paymentTransactions.createdAt,
      rawSubscription: paymentTransactions.rawSubscription,
    })
    .from(paymentTransactions)
    .where(
      and(
        // Whatever case the id was written in: missing a legacy row here would credit its
        // captures a second time.
        sql`lower(${paymentTransactions.notificationId}) = ${subscriptionId.toLowerCase()}`,
        or(isNotNull(paymentTransactions.easypayTransactionId), inArray(paymentTransactions.action, CREDIT_ACTIONS)),
      ),
    )
    .limit(1000);
  const captures = uncountedPaidCaptures(subscription, ledger);
  if (captures.length === 0) return { credited: [], expiresAt: null };

  // Money arrived, so access is extended whatever happens to the subscription ids. A
  // capture can come before its subscription_create, so it may be the one that swaps the
  // new subscription in; a capture on one already replaced must not swap it back.
  const adoption = await adoptSubscription(user, subscriptionId, subscription);
  let note: string | null = null;
  let idFields: Partial<Extract<Adoption, { outcome: "adopt" }>["fields"]> = {};
  if (adoption.outcome === "stale") {
    note = `capture on replaced ${subscriptionId}`;
  } else if (adoption.outcome === "discard") {
    // The money is in, so access is extended, but this subscription is not the member's.
    note = `discarded ${subscriptionId}${stopSuffix(adoption.stop)}`;
    if (adoption.stop === "failed") {
      console.error(
        `[EASYPAY CREDIT] user ${user.id} paid through ${subscriptionId}, which must not charge (${adoption.reason}), but it could not be stopped`,
      );
    }
  } else if (adoption.outcome === "adopt") {
    idFields = adoption.fields;
    if (adoption.previous) {
      // Unlike subscription_create, a failed stop here does not fail the request: the
      // capture must not be lost. The note marks the old id as replaced, so its next
      // charge is recognised as stale and the stop is tried again then.
      note = `replaced ${adoption.previous}${stopSuffix(adoption.stop)}`;
      if (adoption.stop === "failed") {
        console.error(
          `[EASYPAY CREDIT] user ${user.id} now pays through ${subscriptionId}, but ${adoption.previous} could not be stopped and may charge again`,
        );
      }
    }
  }

  const interval = intervalFromFrequency(subscription.frequency);
  const amount = typeof subscription.value === "number" ? String(subscription.value) : null;
  const currency = typeof subscription.currency === "string" ? subscription.currency : null;
  const credited: string[] = [];
  let firstWasActive: boolean | null = null;
  let expiresAt: Date | null = null;

  for (const capture of captures) {
    const first = credited.length === 0;
    const done = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          subscriptionStatus: users.subscriptionStatus,
          subscriptionExpiresAt: users.subscriptionExpiresAt,
          subscriptionAmount: users.subscriptionAmount,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .for("update");
      if (!locked) return null;
      // Real access, not the stored status: a lapsed member still reads "active" and is
      // joining again, so they are "activated" and get the welcome.
      const wasActive = hasActiveSubscription(locked);
      const next = expiryAfterCapture(locked.subscriptionExpiresAt, interval, capture.at);
      const won = await tx
        .insert(paymentTransactions)
        .values({
          userId: user.id,
          notificationId: subscriptionId,
          notificationType: "subscription_capture",
          notificationStatus: "success",
          dedupeKey: `capture:${capture.id}`,
          easypayTransactionId: capture.id,
          action: wasActive ? "extended" : "activated",
          note: first ? note : null,
          amount: capture.paid === null ? amount : String(capture.paid),
          currency,
          rawPayload: { source, transactionId: capture.id },
          rawSubscription: subscription,
        })
        .onConflictDoNothing()
        .returning({ id: paymentTransactions.id });
      if (won.length === 0) return null;
      await tx
        .update(users)
        .set({
          subscriptionStatus: "active",
          subscriptionSource: "easypay",
          ...(first ? idFields : {}),
          subscriptionExpiresAt: next,
          subscriptionAmount: amount ?? locked.subscriptionAmount,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      return { wasActive, next };
    });
    if (!done) {
      console.log(`[EASYPAY CREDIT] capture ${capture.id} was credited by another request meanwhile`);
      continue;
    }
    if (firstWasActive === null) firstWasActive = done.wasActive;
    credited.push(capture.id);
    expiresAt = done.next;
    console.log(
      `[EASYPAY CREDIT] (${source}) user ${user.id} paid ${capture.paid ?? "?"} ${currency ?? ""} (capture ${capture.id} on ${subscriptionId}) — access through ${done.next.toISOString()}`,
    );
  }

  if (firstWasActive === false && expiresAt && !(await refundEndedAccessOn(user.id, subscriptionId))) {
    const nextPaymentAt = expiresAt;
    sendMembershipEmail(user.email, () =>
      buildWelcomeEmail({
        lang: emailLanguage(user.preferredLanguage),
        firstName: user.firstName,
        amount: Number(amount ?? user.subscriptionAmount ?? 0),
        interval,
        nextPaymentAt,
        manageUrl: membershipUrl(),
        retreatsUrl: `${config.urls.frontend}/`,
      }),
    );
  }
  return { credited, expiresAt };
}

// ─── Reversals ───

/** The fields of `GET /refund/{id}` and `GET /chargeback/{id}` we read (docs.easypay.pt). */
interface EasypayReversalResponse {
  id?: string;
  /** Refunds only: success | pending | failed | waiting. A chargeback has no status. */
  status?: string;
  value?: number;
  amount?: number;
  capture?: { id?: string; payment_id?: string; payment_type?: string };
}

type ReversalCheck =
  /** Easypay has no such refund or chargeback: the notification proves nothing. */
  | { outcome: "not_found" }
  /** A refund Easypay does not (yet) report as completed. */
  | { outcome: "not_final"; status: string }
  /** Real at Easypay, but not on a capture we can show we credited: for a human. */
  | { outcome: "unmatched"; note: string }
  | {
      outcome: "matched";
      userId: number;
      captureId: string;
      subscriptionId: string;
      amount: string | null;
      /** The interval that capture was credited for: the frequency of the subscription as stored with the credit. */
      interval: MembershipInterval;
      /** Epoch ms of the capture: as Easypay listed it in the stored snapshot, else when we credited it. */
      captureAt: number;
    }
  /**
   * The full amount of a teaching order's payment went back. `orderStatus` is "paid", or
   * "refunded" when an earlier notification already applied it.
   */
  | {
      outcome: "matched_teaching";
      orderId: number;
      orderStatus: string;
      userId: number | null;
      paymentId: string;
      amount: string;
    };

/**
 * A refund or chargeback that Easypay reports on a one-off ("single") payment: it counts
 * only when the payment is that of a teaching order we recorded as paid (`easypay_payment_id`
 * is set by `finalizeOrder` from Easypay's own read), and only for the full order amount. A
 * partial reversal, or one on an order we never recorded as paid, is left to a human.
 * Null when no teaching order has that payment.
 */
async function matchTeachingReversal(
  kind: "refund" | "chargeback",
  id: string,
  reversal: EasypayReversalResponse,
  paymentId: string | null,
): Promise<ReversalCheck | null> {
  if (!paymentId) return null;
  const [order] = await db
    .select({
      id: teachingOrders.id,
      userId: teachingOrders.userId,
      status: teachingOrders.status,
      amountCents: teachingOrders.amountCents,
    })
    .from(teachingOrders)
    .where(sql`lower(${teachingOrders.easypayPaymentId}) = ${paymentId}`)
    .limit(1);
  if (!order) return null;
  if (order.status !== "paid" && order.status !== "refunded") {
    return { outcome: "unmatched", note: `${kind} ${id} on order ${order.id}, which is ${order.status}, not paid` };
  }
  const value = typeof reversal.value === "number" ? reversal.value : reversal.amount;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { outcome: "unmatched", note: `${kind} ${id} on order ${order.id} names no amount` };
  }
  if (Math.round(value * 100) < order.amountCents) {
    return {
      outcome: "unmatched",
      note: `partial ${kind} ${id} on order ${order.id}: ${value} of ${order.amountCents / 100}`,
    };
  }
  return {
    outcome: "matched_teaching",
    orderId: order.id,
    orderStatus: order.status,
    userId: order.userId,
    paymentId,
    amount: String(value),
  };
}

/**
 * Read a refund or chargeback back from Easypay and find what it reverses. A membership
 * capture counts when it is among the ones we credited: a credit row carrying that capture
 * id, or a pre-2026-11-16 credit of the same subscription whose stored snapshot lists it. A
 * one-off payment counts when it is a paid teaching order's (see `matchTeachingReversal`).
 * Easypay's `capture.payment_type` decides which of the two is looked at; without it, both.
 *
 * Whether `capture.id` of a refund equals the `transactions[].id` of the subscription is
 * not stated by the documentation; if it does not, nothing matches and every reversal is
 * left to a human — which fails safe, since a paying member's access is never closed on a
 * guess. THROWS on any Easypay answer other than 404, so the webhook retries.
 */
async function verifyReversal(kind: "refund" | "chargeback", id: string): Promise<ReversalCheck> {
  let reversal: EasypayReversalResponse;
  try {
    reversal = await easypayFetch<EasypayReversalResponse>(`/${kind}/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof EasypayHttpError && err.easypayStatus === 404) return { outcome: "not_found" };
    throw err;
  }
  const status = (reversal.status ?? "").toLowerCase();
  if (kind === "refund" && status !== "success") return { outcome: "not_final", status: status || "-" };

  const captureId = typeof reversal.capture?.id === "string" ? reversal.capture.id.toLowerCase() : null;
  if (!captureId || !EASYPAY_ID.test(captureId)) return { outcome: "unmatched", note: `${kind} ${id} names no capture` };
  const paymentId = typeof reversal.capture?.payment_id === "string" ? reversal.capture.payment_id.toLowerCase() : null;
  // SINGLE | FREQUENT | SUBSCRIPTION per the documentation; absent, both kinds are tried.
  const paymentType = typeof reversal.capture?.payment_type === "string" ? reversal.capture.payment_type.toLowerCase() : null;
  if (paymentType === "single") {
    return (
      (await matchTeachingReversal(kind, id, reversal, paymentId)) ?? {
        outcome: "unmatched",
        note: `${kind} ${id} on payment ${paymentId ?? "-"}, which is no teaching order of ours`,
      }
    );
  }

  const rows = await db
    .select({
      userId: paymentTransactions.userId,
      notificationId: paymentTransactions.notificationId,
      action: paymentTransactions.action,
      easypayTransactionId: paymentTransactions.easypayTransactionId,
      rawSubscription: paymentTransactions.rawSubscription,
      createdAt: paymentTransactions.createdAt,
    })
    .from(paymentTransactions)
    .where(
      or(
        eq(paymentTransactions.easypayTransactionId, captureId),
        paymentId
          ? and(
              sql`lower(${paymentTransactions.notificationId}) = ${paymentId}`,
              inArray(paymentTransactions.action, CREDIT_ACTIONS),
              isNull(paymentTransactions.easypayTransactionId),
            )
          : undefined,
      ),
    )
    .limit(1000);
  const credit =
    rows.find((r) => r.easypayTransactionId?.toLowerCase() === captureId) ??
    rows.find(
      (r) =>
        !r.easypayTransactionId &&
        CREDIT_ACTIONS.includes(r.action) &&
        r.notificationId.toLowerCase() === paymentId &&
        listCaptures(r.rawSubscription).some((c) => c.id === captureId),
    );
  if (!credit) {
    const teaching = paymentType === null ? await matchTeachingReversal(kind, id, reversal, paymentId) : null;
    if (teaching) return teaching;
    return { outcome: "unmatched", note: `${kind} ${id} on capture ${captureId}, which we never credited` };
  }
  if (paymentId && credit.notificationId.toLowerCase() !== paymentId) {
    return { outcome: "unmatched", note: `${kind} ${id}: capture ${captureId} was credited on ${credit.notificationId}, not ${paymentId}` };
  }
  if (credit.userId === null) return { outcome: "unmatched", note: `${kind} ${id} on capture ${captureId} of a deleted account` };
  const value = typeof reversal.value === "number" ? reversal.value : reversal.amount;
  // raw_subscription is the Easypay subscription read when the capture was credited (jsonb).
  const snapshot = credit.rawSubscription as EasypaySubscriptionResponse | null;
  return {
    outcome: "matched",
    userId: credit.userId,
    captureId,
    subscriptionId: credit.notificationId,
    amount: typeof value === "number" ? String(value) : null,
    interval: intervalFromFrequency(snapshot?.frequency),
    captureAt: listCaptures(snapshot).find((c) => c.id === captureId)?.at ?? new Date(credit.createdAt).getTime(),
  };
}

/**
 * Rows showing reversal `id` (a refund's or a chargeback's own id) already applied by
 * another notification than `txId`.
 */
function alreadyAppliedCondition(id: string, txId: number) {
  return and(
    sql`lower(${paymentTransactions.notificationId}) = ${id.toLowerCase()}`,
    inArray(paymentTransactions.action, REVERSAL_APPLIED_ACTIONS),
    ne(paymentTransactions.id, txId),
  );
}

/**
 * The Easypay subscriptions a chargeback stops, lower-cased: the one the disputed capture was
 * paid through and the member's current one (they differ after a card update). Mock ids have
 * nothing at Easypay to stop.
 */
function subscriptionsToStop(captureSubscription: string, stored: string | null): string[] {
  const ids = [captureSubscription, stored]
    .filter((x): x is string => typeof x === "string" && x !== "" && !x.startsWith("mock_"))
    .map((x) => x.toLowerCase());
  return [...new Set(ids)];
}

// ─── Routes ───

const paymentRoutes = new Hono();

/**
 * POST /api/payment/subscribe
 * Creates an Easypay Checkout session for a monthly subscription.
 * Returns a URL to the checkout page.
 * In mock mode: activates subscription directly and returns success URL.
 */
paymentRoutes.post("/subscribe", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  if (!user) throw AppError.notFound("User not found");

  // Judge by real access, not the raw status: an admin-granted access whose date has
  // passed still reads "active", and those members must be able to join.
  if (hasActiveSubscription(user)) {
    throw AppError.badRequest("You are already a member");
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = parseContribution(body?.amount, body?.interval);
  if (!parsed.ok) throw AppError.badRequest(parsed.error, "INVALID_CONTRIBUTION");
  const { amount, interval } = parsed;
  const language = body?.language === "pt" ? "pt" : "en";

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Activating membership for user ${user.id}`);
    await mockCreateSubscription(user.id, amount, interval);
    return c.json({
      url: `${config.urls.frontend}/membership/confirming?checkout=mock_session`,
      checkout: { id: "mock_session", session: "mock" },
      testing: true,
    });
  }

  // A Direct Debit still at the bank must not be paid for a second time.
  if (await isFirstPaymentProcessing(user, await loadProgressRows(user.id))) {
    throw new AppError(409, "Your first payment is still being processed.", "MEMBERSHIP_PROCESSING");
  }

  // Create Easypay checkout session
  // capture_now charges the first period at signup. The recurring cycle must therefore
  // start one interval later: with start_time a few minutes out (as before), Easypay also
  // ran the first cycle straight away and every new member was charged twice — observed
  // in the sandbox on 2026-10-07 (subscriptions b6fdf47b…, c7e8ea02…).
  // Benefactor associates (Estatutos, art. 3.º, 1, b)) give a regular donation: the
  // payment form and the bank statement say so, in the member's language.
  const label =
    language === "pt"
      ? interval === "year" ? "Donativo anual Padmakara" : "Donativo mensal Padmakara"
      : interval === "year" ? "Padmakara donation (yearly)" : "Padmakara donation (monthly)";

  const checkoutData = await easypayFetch<EasypayCheckoutResponse>("/checkout", {
    method: "POST",
    body: JSON.stringify({
      type: ["subscription"],
      payment: {
        methods: ["cc", "dd"],
        type: "sale",
        capture: {
          descriptive: "Donativo Padmakara",
        },
        currency: "EUR",
        start_time: easypayDateTime(addInterval(new Date(), interval)),
        frequency: frequencyFor(interval),
        expiration_time: "2030-12-31 23:59",
        capture_now: true,
        retries: 2,
      },
      order: {
        items: [
          {
            description: label,
            quantity: 1,
            key: `padmakara-membership-user-${user.id}`,
            value: amount,
          },
        ],
        key: `user-${user.id}-${Date.now()}`,
        value: amount,
      },
      customer: {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
        email: user.email,
        phone_indicative: "+351",
        key: `user-${user.id}`,
      },
    }),
  });

  // The only trace of a Direct Debit in flight (see CHECKOUT_TYPE). Never fatal: the
  // checkout exists at Easypay either way.
  try {
    await db
      .insert(paymentTransactions)
      .values({
        userId: user.id,
        notificationId: checkoutData.id,
        notificationType: CHECKOUT_TYPE,
        notificationStatus: null,
        dedupeKey: `${CHECKOUT_TYPE}:${checkoutData.id}`,
        action: "checkout_created",
        amount: String(amount),
        currency: "EUR",
        rawPayload: { checkoutId: checkoutData.id, amount, interval },
      })
      .onConflictDoNothing({ target: paymentTransactions.dedupeKey });
  } catch (err) {
    console.error(`[PAYMENT] could not record checkout ${checkoutData.id}:`, err);
  }

  // Store the checkout session id so we can link it back in the webhook
  // The checkout page URL includes the manifest session for the SDK
  const checkoutPageUrl = `${config.urls.backend}/api/payment/checkout/${checkoutData.id}?session=${encodeURIComponent(checkoutData.session)}&amount=${amount}&interval=${interval}&lang=${language}`;

  // url stays as the hosted-page fallback; the app embeds the form from checkout + testing.
  return c.json({
    url: checkoutPageUrl,
    checkout: { id: checkoutData.id, session: checkoutData.session },
    testing: config.easypay.testing,
  });
});

const CHECKOUT_COPY = {
  en: {
    title: "Padmakara — Payment",
    update: "Update payment method",
    monthly: "Monthly donation",
    yearly: "Yearly donation",
    perMonth: "month",
    perYear: "year",
    declined:
      "Your payment was declined. Nothing was charged. Try another card, or pay by Direct Debit.",
    footer: "🔒 Your card details go to Easypay, never to Padmakara.",
    fatal: "We could not load the payment form. Nothing was charged.",
    back: "Back to membership",
    cancel: "Cancel and return to Padmakara",
  },
  pt: {
    title: "Padmakara — Pagamento",
    update: "Atualizar o método de pagamento",
    monthly: "Donativo mensal",
    yearly: "Donativo anual",
    perMonth: "mês",
    perYear: "ano",
    declined:
      "O pagamento foi recusado. Nada foi cobrado. Experimente outro cartão ou pague por Débito Direto.",
    footer: "🔒 Os dados do seu cartão vão para a Easypay, nunca para a Padmakara.",
    fatal: "Não foi possível carregar o formulário de pagamento. Nada foi cobrado.",
    back: "Voltar à adesão",
    cancel: "Cancelar e voltar à Padmakara",
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON for a script context: `<` is escaped so `</script>` cannot break out. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * GET /api/payment/checkout/:id
 * Serves an HTML page that embeds the Easypay checkout SDK.
 * This page is opened by the mobile app or web browser.
 */
paymentRoutes.get("/checkout/:id", async (c) => {
  const session = c.req.query("session");
  if (!session) {
    return c.text("Missing checkout session", 400);
  }

  const id = c.req.param("id");
  const lang: "en" | "pt" = c.req.query("lang") === "pt" ? "pt" : "en";
  const isUpdate = c.req.query("mode") === "update";
  const interval = c.req.query("interval") === "year" ? "year" : "month";
  const copy = CHECKOUT_COPY[lang];
  const frontend = config.urls.frontend;

  const amountRaw = c.req.query("amount");
  const amount = amountRaw !== undefined && amountRaw.trim() !== "" ? Number(amountRaw) : NaN;
  const amountOk = Number.isFinite(amount) && amount > 0 && amount < 100000;

  let headline = "";
  if (isUpdate) {
    headline = copy.update;
  } else if (amountOk) {
    const label = interval === "year" ? copy.yearly : copy.monthly;
    const per = interval === "year" ? copy.perYear : copy.perMonth;
    const formatted = amount.toLocaleString(lang === "pt" ? "pt-PT" : "en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    });
    headline =
      lang === "pt"
        ? `${label} — ${formatted} € / ${per}`
        : `${label} — €${formatted} / ${per}`;
  }

  const successUrl = `${frontend}/membership/confirming?checkout=${encodeURIComponent(id)}${isUpdate ? "&mode=update" : ""}`;
  const closeUrl = `${frontend}/membership/closed`;
  const backUrl = `${frontend}/membership`;
  const cancelUrl = isUpdate ? backUrl : closeUrl;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(copy.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@500;600&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #ffffff; color: #333; min-height: 100vh; }
    main { max-width: 480px; margin: 0 auto; padding: 24px 16px; }
    header { text-align: center; margin-bottom: 20px; }
    .brand { font-family: 'EB Garamond', Georgia, serif; font-weight: 600; letter-spacing: 0.18em; color: #9b1b1b; font-size: 1.6rem; }
    .order { margin-top: 8px; color: #555; font-size: 1rem; }
    #declined { display: none; background: #fdf1f1; border: 1px solid #e8bcbc; color: #7a1414; border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; font-size: 0.95rem; }
    #easypay-checkout { min-height: 400px; }
    .error { color: #7a1414; text-align: center; margin-top: 20px; }
    .error a { color: #9b1b1b; display: inline-block; margin-top: 12px; }
    .cancel-row { text-align: center; margin-top: 16px; }
    .cancel-row a { color: #9b1b1b; font-size: 0.95rem; }
    footer { text-align: center; color: #777; font-size: 0.85rem; margin-top: 20px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">PADMAKARA</div>
      ${headline ? `<p class="order">${escapeHtml(headline)}</p>` : ""}
    </header>
    <div id="declined" role="alert">${escapeHtml(copy.declined)}</div>
    <div id="easypay-checkout"></div>
    <p class="cancel-row"><a class="cancel" href="${escapeHtml(cancelUrl)}">${escapeHtml(copy.cancel)}</a></p>
    <footer>${escapeHtml(copy.footer)}</footer>
  </main>
  <script src="${EASYPAY_CHECKOUT_SDK}"></script>
  <script>
    var manifest = ${scriptJson({ id, session })};
    var fatalCopy = ${scriptJson({ message: copy.fatal, back: copy.back, backUrl })};
    easypayCheckout.startCheckout(manifest, {
      id: 'easypay-checkout',
      display: 'inline',
      testing: ${config.easypay.testing ? "true" : "false"},
      language: ${scriptJson(lang === "pt" ? "pt_PT" : "en")},
      accentColor: '#9b1b1b',
      buttonBackgroundColor: '#9b1b1b',
      inputBorderRadius: 10,
      buttonBorderRadius: 10,
      buttonBoxShadow: false,
      backgroundColor: '#ffffff',
      hideSubscriptionSummary: false,
      onSuccess: function() {
        window.location.href = ${scriptJson(successUrl)};
      },
      onPaymentError: function(error) {
        console.warn('Payment error (retryable):', JSON.stringify(error));
        document.getElementById('declined').style.display = 'block';
      },
      onError: function(error) {
        console.error('Checkout error (fatal):', JSON.stringify(error));
        document.getElementById('declined').style.display = 'none';
        var box = document.getElementById('easypay-checkout');
        box.textContent = '';
        var p = document.createElement('p');
        p.className = 'error';
        p.textContent = fatalCopy.message;
        var a = document.createElement('a');
        a.href = fatalCopy.backUrl;
        a.textContent = fatalCopy.back;
        p.appendChild(document.createElement('br'));
        p.appendChild(a);
        box.appendChild(p);
      },
      onClose: function() {
        window.location.href = ${scriptJson(closeUrl)};
      }
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

/**
 * POST /api/payment/webhook
 * Receives Easypay generic notifications.
 * Verifies by querying Easypay API, then updates user subscription.
 * In mock mode: returns 200 no-op.
 */
// Public endpoint: bound the work an unauthenticated caller can cause. Real
// notifications are a few hundred bytes. The limit is generous because every
// notification comes from a handful of Easypay addresses, so a burst of renewals
// must not be throttled.
paymentRoutes.use(
  "/webhook",
  authIpLimiter({ limit: 600, windowMs: 60_000 }),
  bodyLimit({
    maxSize: WEBHOOK_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  }),
);

paymentRoutes.post("/webhook", async (c) => {
  if (isMockMode) {
    return c.json({ received: true, mock: true });
  }

  const rawBody = await c.req.text();

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ received: true, ignored: "invalid json" });
  }

  const id = typeof body.id === "string" ? body.id : null;
  const type = typeof body.type === "string" ? body.type : null;
  const status = typeof body.status === "string" ? body.status : null;
  const date = typeof body.date === "string" ? body.date : "";

  console.log(`[EASYPAY WEBHOOK] type=${type} status=${status} id=${id}`);

  if (!id) {
    return c.json({ received: true, ignored: "no id" });
  }

  // Answer 200, not 4xx: a notification we will never handle must not be retried.
  if (!EASYPAY_ID.test(id)) {
    console.warn("[EASYPAY WEBHOOK] ignored a notification with a malformed id");
    return c.json({ received: true, ignored: "bad id" });
  }

  // Idempotency. Easypay retries notifications, and a replay must not extend anyone's
  // access twice. Claim the notification first: a duplicate loses on the unique
  // dedupe_key and stops here before touching any user state.
  const dedupeKey = `${id}:${type ?? "-"}:${status ?? "-"}:${date}`;
  const claimed = await db
    .insert(paymentTransactions)
    .values({
      notificationId: id,
      notificationType: type,
      notificationStatus: status,
      dedupeKey,
      action: "received",
      rawPayload: body,
    })
    .onConflictDoNothing({ target: paymentTransactions.dedupeKey })
    .returning({ id: paymentTransactions.id });

  const txId = claimed[0]?.id;
  if (!txId) {
    console.log(`[EASYPAY WEBHOOK] duplicate, already processed: ${dedupeKey}`);
    return c.json({ received: true, duplicate: true });
  }

  const recordOutcome = (fields: Record<string, unknown>) =>
    db
      .update(paymentTransactions)
      .set(fields)
      .where(eq(paymentTransactions.id, txId));

  // Give the claim back and answer 503 so Easypay retries: the claimed dedupe row would
  // otherwise swallow the retry and the notification would be lost for good.
  const retryLater = async (why: string) => {
    console.error(`[EASYPAY WEBHOOK] ${id}: ${why} — answering 503 so Easypay retries`);
    try {
      await db.delete(paymentTransactions).where(eq(paymentTransactions.id, txId));
    } catch (err) {
      // Still answer 503: Easypay retries either way, and a leftover claim only means the
      // retry is treated as a duplicate (the reconcile job still credits any capture).
      console.error(`[EASYPAY WEBHOOK] ${id}: could not release the dedupe row:`, err);
    }
    return c.json({ received: false, retry: true }, 503);
  };

  try {
    // One-off teaching purchases (Easypay "single" payments) share this endpoint. Every
    // subscription notification type starts with "subscription"; anything else (a bare
    // "capture", say) may be a single payment, so it is checked first. Only a payment whose
    // own `key` is `teaching-order-<publicId>` belongs to us: everything else falls through
    // to the paths below, exactly as before.
    if (!(type ?? "").toLowerCase().startsWith("subscription")) {
      try {
        const single = await probeSinglePayment(id);
        let publicId = single && single.key ? (TEACHING_ORDER_KEY.exec(single.key)?.[1] ?? null) : null;
        // Easypay sometimes omits the payment's own key. The notification's key is then only a
        // lookup hint: it is trusted for nothing until the order's own checkout confirms it.
        let hinted = false;
        if (single && !single.key && typeof body.key === "string") {
          publicId = TEACHING_ORDER_KEY.exec(body.key)?.[1] ?? null;
          hinted = publicId !== null;
        }
        if (single && publicId) {
          const order = await db.query.teachingOrders.findFirst({
            where: eq(teachingOrders.publicId, publicId),
          });
          if (!order) {
            console.error(`[EASYPAY WEBHOOK] single payment ${id} references unknown teaching order ${publicId}`);
            await recordOutcome({ action: "teaching_ignored", note: "unknown teaching order" });
            return c.json({ received: true });
          }
          if (hinted && !(await paymentBelongsToOrder(order, id))) {
            console.error(`[EASYPAY WEBHOOK] payment ${id} is not the payment of teaching order ${order.id}; ignored`);
            await recordOutcome({ action: "teaching_ignored", note: "payment not linked to the hinted order" });
            return c.json({ received: true });
          }
          // Reads the status and amount from Easypay (never from this body) and finalizes
          // idempotently: a duplicate or a race with the confirmation page grants once.
          const result = await refreshOrderFromEasypay(order, single);
          console.log(`[EASYPAY WEBHOOK] teaching order ${order.id}: ${result}`);
          // A success notification whose payment Easypay does not yet report as paid may
          // simply be ahead of Easypay's own state: retry. Amount mismatches, key mismatches
          // and the like are deliberate and terminal, so they are not retried.
          if (result === "pending" && (status ?? "").toLowerCase() === "success") {
            return await retryLater(`order ${order.id} not yet paid at Easypay (payment_status ${single.status})`);
          }
          await recordOutcome({
            userId: order.userId,
            action: `teaching_${result}`,
            note: `order ${order.id}, payment_status ${single.status}`,
            amount: single.amountCents === null ? null : String(single.amountCents / 100),
          });
          return c.json({ received: true });
        }
      } catch (err) {
        return await retryLater(`teaching branch failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    const kind = classifyNotification(type, status);

    // A refund or chargeback names its own resource (Easypay's notification table: the id is
    // the refund's, or the chargeback's), never the subscription. Access changes only when
    // Easypay reports that resource on a capture we credited.
    if (kind === "reversal") {
      const t = (type ?? "").toLowerCase();
      if (t !== "refund" && t !== "chargeback") {
        console.error(`[EASYPAY WEBHOOK] ${type} ${id} cannot be verified automatically — recorded for a human`);
        await recordOutcome({ action: "reversal_review", note: `${type}/${status}: not verified automatically` });
        return c.json({ received: true });
      }
      const check = await verifyReversal(t, id);
      if (check.outcome === "not_found") {
        console.error(`[EASYPAY WEBHOOK] ${t} ${id} not found at Easypay — nothing changed`);
        await recordOutcome({ action: "unverified", note: `${t} not found at Easypay (404)` });
        return c.json({ received: true });
      }
      if (check.outcome === "not_final") {
        console.warn(`[EASYPAY WEBHOOK] refund ${id} is ${check.status} at Easypay — nothing changed yet`);
        await recordOutcome({ action: "ignored", note: `refund status ${check.status}` });
        return c.json({ received: true });
      }
      if (check.outcome === "unmatched") {
        console.error(`[EASYPAY WEBHOOK] ${check.note} — recorded for a human, access unchanged`);
        await recordOutcome({ action: "reversal_review", note: check.note });
        return c.json({ received: true });
      }
      if (check.outcome === "matched_teaching") {
        const where = `${t} ${id} on order ${check.orderId} (payment ${check.paymentId})`;
        const reversed = check.orderStatus === "paid" ? await reverseTeachingOrder(check.orderId) : null;
        if (!reversed || reversed.outcome === "already") {
          // A replay, or a race with another copy of this notification: applied once already.
          await recordOutcome({ userId: check.userId, action: "ignored", note: `${where} already applied` });
          return c.json({ received: true });
        }
        await recordOutcome({
          userId: check.userId,
          action: "teaching_reversed",
          note: `${where}; ${reversed.grantRemoved ? "purchase access removed" : "no purchase grant to remove"}`,
          amount: check.amount,
        });
        console.log(`[EASYPAY WEBHOOK] ${where} — order refunded, purchase access removed: ${reversed.grantRemoved}`);
        return c.json({ received: true });
      }
      // A capture we credited went back. A refund takes back that capture's interval; a
      // chargeback ends the membership (DECISIONS.md, 2026-11-17).
      const where = `${t} ${id} on capture ${check.captureId} (${check.subscriptionId})`;
      const applied = alreadyAppliedCondition(id, txId);

      // A replay of a reversal already applied changes nothing, and stops nothing again.
      if ((await db.select({ id: paymentTransactions.id }).from(paymentTransactions).where(applied).limit(1)).length > 0) {
        await recordOutcome({ userId: check.userId, action: "ignored", note: `${where} already applied` });
        return c.json({ received: true });
      }

      let stopped: string[] = [];
      if (t === "chargeback") {
        const member = await db.query.users.findFirst({ where: eq(users.id, check.userId) });
        stopped = subscriptionsToStop(check.subscriptionId, member?.easypaySubscriptionId ?? null);
        // Stopped before anything is written: if Easypay does not confirm, the claim is given
        // back and nothing is applied, so Easypay's retry starts clean and tries again.
        for (const sid of stopped) {
          if ((await deactivateAtEasypay(sid)) === "failed") {
            return await retryLater(`${where}: subscription ${sid} could not be stopped`);
          }
        }
      }

      // The member row is locked so a capture credited meanwhile, or a second copy of this
      // notification, is serialised with this write; the replay check is made again under it.
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            subscriptionStatus: users.subscriptionStatus,
            subscriptionExpiresAt: users.subscriptionExpiresAt,
            subscriptionCancelledAt: users.subscriptionCancelledAt,
            easypaySubscriptionId: users.easypaySubscriptionId,
          })
          .from(users)
          .where(eq(users.id, check.userId))
          .for("update");
        if (!locked) return { outcome: "review", note: `${where}: user ${check.userId} not found` } as const;
        if ((await tx.select({ id: paymentTransactions.id }).from(paymentTransactions).where(applied).limit(1)).length > 0) {
          return { outcome: "already" } as const;
        }
        const now = new Date();
        const from = locked.subscriptionExpiresAt;
        let set: Partial<typeof users.$inferInsert>;
        let action: string;
        let note: string;
        if (t === "chargeback") {
          const current = locked.easypaySubscriptionId;
          if (current && !current.startsWith("mock_") && !stopped.includes(current.toLowerCase())) {
            // A card update swapped the subscription after the stop above: throw, so the claim
            // is given back and the retry stops the new one too.
            throw new Error(`stored subscription changed to ${current} while ${where} was applied`);
          }
          set = {
            subscriptionStatus: "expired",
            subscriptionExpiresAt: now,
            subscriptionCancelledAt: locked.subscriptionCancelledAt ?? now,
          };
          action = CHARGEBACK_APPLIED;
          note = `${where}; paid through ${from?.toISOString() ?? "-"} -> ${now.toISOString()}; stopped ${stopped.join(", ")}`;
        } else {
          if (!from) {
            return { outcome: "review", note: `${where}: the member has no paid-through date to take an interval from` } as const;
          }
          const to = expiryAfterRefund(from, check.interval, check.captureAt);
          set = { subscriptionExpiresAt: to, ...(to <= now ? { subscriptionStatus: "expired" } : {}) };
          action = REFUND_APPLIED;
          note = `${where}; one ${check.interval} removed, paid through ${from.toISOString()} -> ${to.toISOString()}`;
        }
        await tx.update(users).set({ ...set, updatedAt: now }).where(eq(users.id, check.userId));
        await tx
          .update(paymentTransactions)
          .set({ userId: check.userId, action, note, amount: check.amount })
          .where(eq(paymentTransactions.id, txId));
        return { outcome: "applied", note } as const;
      });

      if (result.outcome === "already") {
        await recordOutcome({ userId: check.userId, action: "ignored", note: `${where} already applied` });
      } else if (result.outcome === "review") {
        console.error(`[EASYPAY WEBHOOK] ${result.note} — recorded for a human, access unchanged`);
        await recordOutcome({ userId: check.userId, action: "reversal_review", note: result.note });
      } else {
        console.log(`[EASYPAY WEBHOOK] user ${check.userId}: ${result.note}`);
      }
      return c.json({ received: true });
    }

    // Never act on the request body — re-read the subscription from Easypay and trust
    // only what Easypay itself says about it.
    let subscription: EasypaySubscriptionResponse;
    try {
      subscription = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(id)}`);
    } catch (err) {
      // Only a 404 says "this id is not a subscription we can read": the `id` namespace
      // differs per resource type, and a notification can concern another account. That is
      // recorded for a human and answered 200, so Easypay does not retry it forever; the
      // reconcile job reads recent ones again in case Easypay was only behind. Anything
      // else (5xx, 401/403, 429, a network error) leaves the answer unknown: retry.
      if (err instanceof EasypayHttpError && err.easypayStatus === 404) {
        console.error(`[EASYPAY WEBHOOK] ${type}/${status} for ${id}, which Easypay does not know as a subscription (404)`);
        await recordOutcome({ action: "unverified", note: SUBSCRIPTION_NOT_FOUND_NOTE });
        return c.json({ received: true });
      }
      return await retryLater(`could not read the subscription (${err instanceof Error ? err.message : String(err)})`);
    }

    // From here on, Easypay's own spelling of the id. The id check above accepts either
    // case, but the ledger and the stored subscription id hold Easypay's form: an
    // upper-case copy must not look like an unknown subscription with captures never
    // counted, nor like a new subscription to swap in.
    const subscriptionId =
      typeof subscription.id === "string" && subscription.id.toLowerCase() === id.toLowerCase()
        ? subscription.id
        : id.toLowerCase();

    const amount = typeof subscription.value === "number" ? String(subscription.value) : null;
    const currency = typeof subscription.currency === "string" ? subscription.currency : null;
    const userId = resolveUserId(subscription);

    if (userId === null) {
      console.error(
        `[EASYPAY WEBHOOK] cannot attribute ${id} to a user — customer.key=${JSON.stringify(subscription.customer?.key)}`,
      );
      await recordOutcome({
        action: "unresolved",
        note: "customer.key did not match user-{id}",
        rawSubscription: subscription,
        amount,
        currency,
      });
      return c.json({ received: true });
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      console.error(`[EASYPAY WEBHOOK] ${id} references unknown user ${userId}`);
      await recordOutcome({
        action: "unresolved",
        note: `user ${userId} not found`,
        rawSubscription: subscription,
        amount,
        currency,
      });
      return c.json({ received: true });
    }

    const common = { userId, rawSubscription: subscription, amount, currency };

    // subscription_create is a stored card or a signed mandate, never money: it decides which
    // subscription is the member's and nothing else. Its captures are credited by their own
    // notification, or by the reconcile job.
    if ((type ?? "").toLowerCase() === "subscription_create" && (status ?? "").toLowerCase() === "success") {
      // The body's type/status only say "look"; whether this subscription may replace (or be
      // stopped in favour of) the stored one is decided on Easypay's own record of it.
      if (subscriptionId !== user.easypaySubscriptionId) {
        const refusal = adoptionRefusal(subscription);
        if (refusal) {
          console.error(
            `[EASYPAY WEBHOOK] subscription_create for ${subscriptionId} (user ${userId}) not acted on: ${refusal} — nothing stopped, stored id kept`,
          );
          await recordOutcome({ ...common, action: CREATE_NOT_ADOPTED, note: refusal });
          return c.json({ received: true });
        }
      }
      const adoption = await adoptSubscription(user, subscriptionId, subscription, { strict: true });
      if (adoption.outcome === "stale") {
        await recordOutcome({ ...common, action: "ignored", note: `create on replaced ${subscriptionId}` });
        return c.json({ received: true });
      }
      // Whichever subscription had to be stopped (the old one on a card update, or the new
      // one that must not charge): if Easypay did not confirm, it would keep charging. Give
      // the claim back and fail, so Easypay retries this notification and the retry tries the
      // deactivation again. Nothing on the user row has changed yet, so the retry starts clean.
      if (adoption.outcome !== "current" && adoption.stop === "failed") {
        return await retryLater(`for user ${userId} (${adoption.outcome}) left a subscription that could not be stopped`);
      }
      if (adoption.outcome === "discard") {
        await recordOutcome({
          ...common,
          action: adoption.reason === "cancelled" ? "replacement_cancelled" : "stale_replacement",
          note: `discarded ${subscriptionId}${stopSuffix(adoption.stop)}`,
        });
        return c.json({ received: true });
      }
      if (adoption.outcome === "adopt") {
        // A card update creates a fresh subscription: the old one is stopped so the member is
        // not charged twice, and any cancellation is cleared since they are paying again.
        await db.update(users).set({ ...adoption.fields, updatedAt: new Date() }).where(eq(users.id, userId));
        if (adoption.previous) {
          await recordOutcome({
            ...common,
            action: "method_updated",
            note: `replaced ${adoption.previous}${stopSuffix(adoption.stop)}`,
          });
          return c.json({ received: true });
        }
      }
      await recordOutcome({ ...common, action: "tokenized" });
      return c.json({ received: true });
    }

    // Whatever the body says, money is what Easypay lists as paid and not yet counted.
    const credit = await creditNewCaptures(user, subscriptionId, subscription, "webhook");
    if (credit.credited.length > 0) {
      await recordOutcome({
        ...common,
        action: "credited",
        note: `credited ${credit.credited.join(", ")}; notification said ${type}/${status}`,
      });
      return c.json({ received: true });
    }

    if (kind === "payment") {
      // A success notification with nothing new at Easypay: a forgery, a replay, or a
      // notification ahead of Easypay's own list. Nothing changes; the reconcile job picks
      // the capture up if it appears later.
      console.warn(
        `[EASYPAY WEBHOOK] ${type}/${status} for user ${userId} on ${subscriptionId}, but Easypay lists no paid capture that is not already counted`,
      );
      await recordOutcome({ ...common, action: NO_NEW_CAPTURE, note: `notification said ${type}/${status}` });
      return c.json({ received: true });
    }

    // Failed charge, or a type we do not recognise: change nothing. Easypay retries twice
    // on its own, and access lapses by itself at the paid-through date plus grace.
    // Revoking here would cut off a paying member over one transient decline.
    if (kind === "unknown") {
      console.warn(
        `[EASYPAY WEBHOOK] unrecognised type/status "${type}"/"${status}" for user ${userId} — stored, no action taken`,
      );
    }
    await recordOutcome({ ...common, action: "ignored", note: kind });
    if (kind !== "payment_failed") return c.json({ received: true });

    // Only while access still runs: once it has ended the grace date is in the past, and a
    // failed rejoin charge is answered by the checkout itself, not by a "renewal failed" email.
    const renewalFailed = !!user.subscriptionExpiresAt && hasActiveSubscription(user);
    // A first payment that failed: nothing was charged and there is no membership (or no
    // longer one: a lapsed member rejoining has a past expiry date). The checkout page itself
    // said "declined" for a card, but a Direct Debit fails days later.
    const firstPaymentFailed = !renewalFailed && !hasActiveSubscription(user) && !(await hasBeenPaidBefore(subscriptionId));
    if (!renewalFailed && !firstPaymentFailed) return c.json({ received: true });

    // Easypay sends one failed notification per retry (`retries: 2`): one email per failure
    // episode is enough, so stay quiet if this subscription already had one lately.
    if (await alreadyToldAboutFailure(subscriptionId, txId)) {
      console.log(`[EASYPAY WEBHOOK] ${id} failed again within ${FAILURE_EMAIL_WINDOW_DAYS} days — no second email`);
      return c.json({ received: true });
    }

    if (renewalFailed) {
      const graceUntil = graceEnd(user.subscriptionExpiresAt!);
      sendMembershipEmail(user.email, () =>
        buildPaymentFailedEmail({
          lang: emailLanguage(user.preferredLanguage),
          firstName: user.firstName,
          graceUntil,
          updateUrl: membershipUrl(),
        }),
      );
    } else {
      sendMembershipEmail(user.email, () =>
        buildFirstPaymentFailedEmail({
          lang: emailLanguage(user.preferredLanguage),
          firstName: user.firstName,
          joinUrl: membershipUrl(),
        }),
      );
    }
    return c.json({ received: true });
  } catch (err) {
    // A database write (or an Easypay read) failed after the claim: without this the claim
    // would stay and swallow Easypay's retry. Every step above is safe to run again —
    // captures are credited once by their id, deactivations are idempotent.
    return await retryLater(`processing failed (${err instanceof Error ? err.message : String(err)})`);
  }
});

/**
 * GET /api/payment/membership
 * Everything the membership page shows. The Easypay lookup (card details, interval) is
 * best effort: if Easypay is down the page still renders, just without those two fields.
 */
paymentRoutes.get("/membership", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
  if (!user) throw AppError.notFound("User not found");

  const rows = await db
    .select({
      notificationType: paymentTransactions.notificationType,
      notificationId: paymentTransactions.notificationId,
      action: paymentTransactions.action,
      note: paymentTransactions.note,
      amount: paymentTransactions.amount,
      createdAt: paymentTransactions.createdAt,
    })
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.userId, user.id),
        inArray(paymentTransactions.notificationType, [...PROGRESS_TYPES, ...REVERSAL_TYPES]),
      ),
    )
    .orderBy(desc(paymentTransactions.createdAt))
    .limit(50);

  const captures = rows.filter(isChargeRow);
  const processing = await isFirstPaymentProcessing(user, rows);
  const state = membershipState(user, captures[0] ?? null, processing);

  const history: MembershipView["history"] = [];
  for (const r of rows) {
    const outcome = historyOutcome(r.action, r.note);
    if (!outcome) continue;
    history.push({
      date: r.createdAt.toISOString(),
      amount: r.amount === null ? null : Number(r.amount),
      outcome,
    });
    if (history.length === HISTORY_LIMIT) break;
  }

  let method: MembershipView["method"] = null;
  let interval: MembershipView["interval"] = null;
  const subId = user.easypaySubscriptionId;
  if (user.subscriptionSource === "easypay" && subId && !subId.startsWith("mock_")) {
    try {
      const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(subId)}`);
      interval = sub.frequency ? intervalFromFrequency(sub.frequency) : null;
      const kind = methodKind(sub.method?.type);
      if (kind) {
        const m = sub.method as Record<string, unknown>;
        const lastFour = m.last_four ?? m.last_digits;
        const brand = m.card_type ?? m.brand;
        method = {
          type: kind,
          lastFour: typeof lastFour === "string" ? lastFour : null,
          brand: typeof brand === "string" ? brand : null,
        };
      }
    } catch (err) {
      console.error(`[MEMBERSHIP] could not read Easypay subscription ${subId}:`, err);
    }
  }

  let graceUntil: string | null = null;
  if (state === "payment_failed" && user.subscriptionExpiresAt) {
    graceUntil = graceEnd(user.subscriptionExpiresAt).toISOString();
  }

  const view: MembershipView = {
    state,
    source: user.subscriptionSource as MembershipView["source"],
    amount: user.subscriptionAmount === null ? null : Number(user.subscriptionAmount),
    interval,
    accessUntil: user.subscriptionExpiresAt?.toISOString() ?? null,
    graceUntil,
    cancelledAt: user.subscriptionCancelledAt?.toISOString() ?? null,
    method,
    history,
    lastPaymentFailedAt: firstPaymentFailedAt(user, rows),
  };
  return c.json(view);
});

/**
 * GET /api/payment/checkout-status/:id
 * Lets the app show progress after the checkout page closes. Direct debit takes days to
 * settle, so "processing" is a normal, non-error state and not the same as "pending".
 */
paymentRoutes.get("/checkout-status/:id", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
  if (!user) throw AppError.notFound("User not found");

  if (hasActiveSubscription(user)) return c.json({ state: "active", method: null });
  if (isMockMode) return c.json({ state: "pending", method: null });

  // The app polls this every few seconds; one Easypay hiccup must not end the polling
  // with an error screen, so "can't tell yet" is the same answer as "not settled yet".
  let checkout: { payment?: { status?: string; method?: { type?: string } }; method?: { type?: string } };
  try {
    checkout = await easypayFetch(`/checkout/${encodeURIComponent((c.req.param("id") ?? ""))}`);
  } catch (err) {
    console.error(`[MEMBERSHIP] could not read Easypay checkout ${c.req.param("id")}:`, err);
    return c.json({ state: "pending", method: null });
  }

  const method = methodKind(checkout.method?.type ?? checkout.payment?.method?.type);
  const paymentStatus = (checkout.payment?.status ?? "").toLowerCase();
  if (["failed", "error", "deleted"].includes(paymentStatus)) return c.json({ state: "failed", method });
  if (method === "direct_debit") return c.json({ state: "processing", method });
  return c.json({ state: "pending", method });
});

/**
 * POST /api/payment/cancel
 *
 * Stops the subscription renewing. Access is **not** revoked: the member has paid
 * through `subscriptionExpiresAt` and keeps it until then. Returns that date so the
 * client can say when access actually ends.
 *
 * Cancellation being easy and immediate is also a Visa/Mastercard requirement for
 * subscription merchants, so this endpoint must stay a single call with no friction.
 */
paymentRoutes.post("/cancel", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  if (!user) throw AppError.notFound("User not found");

  const accessUntil = user.subscriptionExpiresAt?.toISOString() ?? null;

  // Already cancelled: a double tap or a retry must not hit Easypay again or move the
  // recorded cancellation date.
  if (user.subscriptionCancelledAt) {
    return c.json({ url: membershipUrl(), accessUntil });
  }

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Cancelling subscription for user ${user.id}`);
    await mockCancelSubscription(user.id);
    sendCancelledEmail(user);
    return c.json({ url: membershipUrl(), accessUntil });
  }

  if (!user.easypaySubscriptionId) {
    throw AppError.badRequest("This membership is not paid by card or Direct Debit, so there is nothing to cancel");
  }

  // Stop future charges at Easypay.
  await easypayFetch(`/subscription/${encodeURIComponent(user.easypaySubscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "inactive" }),
  });

  // Record the cancellation but leave status and expiry alone — access runs out on its
  // own at the paid-through date. Expiring it here would take away a period the member
  // has already paid for.
  await db
    .update(users)
    .set({
      subscriptionCancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  sendCancelledEmail(user);
  return c.json({ url: membershipUrl(), accessUntil });
});

// ─── Manage an existing membership ───

/**
 * The signed-in user, who must be paying through Easypay with a real subscription. Admin
 * grants, cash and bank transfers have nothing at Easypay to change.
 */
async function requireEasypayMember(userId: number) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound("User not found");
  const subId = user.easypaySubscriptionId;
  if (user.subscriptionSource !== "easypay" || !subId || subId.startsWith("mock_")) {
    throw AppError.badRequest("This membership is not paid through card or direct debit", "NOT_EASYPAY_MEMBER");
  }
  return { user, subId };
}

/**
 * POST /api/payment/amount
 * The interval always comes from the Easypay subscription, never from the client, so the
 * yearly floor cannot be dodged by claiming to be monthly.
 */
paymentRoutes.post("/amount", authMiddleware, async (c) => {
  const { user, subId } = await requireEasypayMember(getUser(c).id);
  if (!hasActiveSubscription(user)) {
    throw AppError.badRequest("Your membership has ended. Please join again.", "ACCESS_ENDED");
  }

  const body = await c.req.json().catch(() => ({}));
  const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(subId)}`);
  const parsed = parseContribution(body?.amount, intervalFromFrequency(sub.frequency));
  if (!parsed.ok) throw AppError.badRequest(parsed.error, "INVALID_CONTRIBUTION");

  await easypayFetch(`/subscription/${encodeURIComponent(subId)}`, {
    method: "PATCH",
    body: JSON.stringify({ value: parsed.amount }),
  });
  await db
    .update(users)
    .set({ subscriptionAmount: String(parsed.amount), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({ amount: parsed.amount });
});

/**
 * POST /api/payment/resume
 * Undo a cancellation while access still runs. Renewal restarts at the paid-through date,
 * so nothing is charged early.
 */
paymentRoutes.post("/resume", authMiddleware, async (c) => {
  const { user, subId } = await requireEasypayMember(getUser(c).id);
  if (!user.subscriptionCancelledAt) {
    throw AppError.badRequest("This membership is not cancelled", "NOT_CANCELLED");
  }
  if (!hasActiveSubscription(user)) {
    throw AppError.badRequest("Your membership has ended. Please join again.", "ACCESS_ENDED");
  }

  const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(subId)}`);
  // Inside the grace window the paid-through date is already past; Easypay needs a future start.
  const soonest = new Date(Date.now() + 5 * 60 * 1000);
  const restart =
    user.subscriptionExpiresAt && user.subscriptionExpiresAt > soonest ? user.subscriptionExpiresAt : soonest;
  await easypayFetch(`/subscription/${encodeURIComponent(subId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "active",
      frequency: frequencyFor(intervalFromFrequency(sub.frequency)),
      start_time: easypayDateTime(restart),
    }),
  });
  await db
    .update(users)
    .set({ subscriptionCancelledAt: null, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({ accessUntil: user.subscriptionExpiresAt?.toISOString() ?? null });
});

/**
 * POST /api/payment/update-method
 * Opens a fresh checkout to store a new card or mandate. The webhook swaps the new
 * subscription in and deactivates the old one. While access still runs nothing is charged
 * and the first cycle starts when the paid period ends; for a lapsed member it is a rejoin.
 */
paymentRoutes.post("/update-method", authMiddleware, async (c) => {
  const { user, subId } = await requireEasypayMember(getUser(c).id);
  // A new card for a membership that is ending would start charging it again (the webhook
  // stops the new subscription, but the member should not be led into paying for nothing).
  // Once access has ended there is nothing to resume: they join again instead.
  if (user.subscriptionCancelledAt && hasActiveSubscription(user)) {
    throw AppError.badRequest("Resume your membership before changing the payment method.", "MEMBERSHIP_CANCELLED");
  }
  const body = await c.req.json().catch(() => ({}));
  const language = body?.language === "pt" ? "pt" : "en";

  // The new checkout must repeat the current amount and interval exactly. Guessing either
  // (say "month" for a yearly member) would charge the wrong amount, so without Easypay's
  // answer there is no checkout.
  let sub: EasypaySubscriptionResponse | null = null;
  try {
    sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${encodeURIComponent(subId)}`);
  } catch (err) {
    console.error(`[UPDATE-METHOD] could not read Easypay subscription ${subId}:`, err);
  }
  if (!sub || typeof sub.value !== "number" || (sub.frequency !== "1M" && sub.frequency !== "1Y")) {
    throw new AppError(
      502,
      "We could not reach the payment provider. Nothing was changed. Please try again later.",
      "EASYPAY_UNAVAILABLE",
    );
  }
  const amount = sub.value;
  const interval: MembershipInterval = intervalFromFrequency(sub.frequency);

  const active = hasActiveSubscription(user);
  const soonest = new Date(Date.now() + 5 * 60 * 1000);
  const startTime = active
    ? user.subscriptionExpiresAt && user.subscriptionExpiresAt > soonest
      ? user.subscriptionExpiresAt
      : soonest
    : addInterval(new Date(), interval);
  // Benefactor associates (Estatutos, art. 3.º, 1, b)) give a regular donation: the
  // payment form and the bank statement say so, in the member's language.
  const label =
    language === "pt"
      ? interval === "year" ? "Donativo anual Padmakara" : "Donativo mensal Padmakara"
      : interval === "year" ? "Padmakara donation (yearly)" : "Padmakara donation (monthly)";

  const checkoutData = await easypayFetch<EasypayCheckoutResponse>("/checkout", {
    method: "POST",
    body: JSON.stringify({
      type: ["subscription"],
      payment: {
        methods: ["cc", "dd"],
        type: "sale",
        capture: { descriptive: "Padmakara membership" },
        currency: "EUR",
        start_time: easypayDateTime(startTime),
        frequency: frequencyFor(interval),
        expiration_time: "2030-12-31 23:59",
        capture_now: !active,
        retries: 2,
      },
      order: {
        items: [
          { description: label, quantity: 1, key: `padmakara-membership-user-${user.id}`, value: amount },
        ],
        key: `user-${user.id}-${Date.now()}`,
        value: amount,
      },
      customer: {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
        email: user.email,
        phone_indicative: "+351",
        key: `user-${user.id}`,
      },
    }),
  });

  return c.json({
    url: `${config.urls.backend}/api/payment/checkout/${checkoutData.id}?session=${encodeURIComponent(checkoutData.session)}&amount=${amount}&interval=${interval}&lang=${language}&mode=update`,
    checkout: { id: checkoutData.id, session: checkoutData.session },
    testing: config.easypay.testing,
  });
});

export { paymentRoutes };
