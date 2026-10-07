import { Hono } from "hono";
import { eq, and, inArray, desc, gte, ne } from "drizzle-orm";
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
import {
  parseContribution,
  frequencyFor,
  intervalFromFrequency,
  addInterval,
  nextExpiry,
  easypayDateTime,
  type MembershipInterval,
} from "../services/membership.ts";

const EASYPAY_API_BASE = config.easypay.testing
  ? "https://api.test.easypay.pt/2.0"
  : "https://api.prod.easypay.pt/2.0";

const EASYPAY_CHECKOUT_SDK = "https://cdn.easypay.pt/checkout/2.9.1/";

const isMockMode = !config.easypay.accountId;

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
 * having arrived, so it must not be used to grant access.
 */
interface EasypaySubscriptionResponse {
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
 * These sets come from Easypay's documentation, **not from observation**: we have never
 * seen a real subscription capture notification, because the sandbox account cannot
 * complete a card payment (card-on-file returns HTTP 500) and SEPA direct debit takes up
 * to 14 days to confirm. So anything unrecognised is logged loudly and stored verbatim
 * in `payment_transactions` rather than dropped — the first live notification is how we
 * find out what these should really be.
 */
// "subscription_capture" is the type Easypay actually sent for a monthly charge — first
// observed live on 2026-08-09 / 2026-09-09 (see payment_transactions id 1). Without it a
// successful renewal would have been stored and ignored, never extending access.
const PAYMENT_TYPES = new Set(["subscription_capture", "capture", "payment", "subscription"]);
const REVERSAL_TYPES = new Set(["refund", "void", "chargeback", "dispute"]);
const SUCCESS_STATUSES = new Set(["success", "paid", "active", "completed"]);

type NotificationKind = "payment" | "payment_failed" | "reversal" | "unknown";

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
function resolveUserId(subscription: EasypaySubscriptionResponse): number | null {
  const match = /^user-(\d+)$/.exec(subscription.customer?.key ?? "");
  return match ? parseInt(match[1]!, 10) : null;
}

// ─── Easypay API helpers ───

/**
 * An Easypay answer that was not 2xx. It is an AppError.internal to every caller that does
 * not look (so they behave as before: a 500 to our client), but carries Easypay's own status
 * for the few that must tell "refused, 4xx" from "unreachable or broken, 5xx".
 */
class EasypayHttpError extends AppError {
  constructor(public readonly easypayStatus: number) {
    super(500, `Easypay API error: ${easypayStatus}`, "INTERNAL_ERROR");
    this.name = "EasypayHttpError";
  }
}

async function easypayFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
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

const newestProgressRow = <T extends { notificationType: string | null }>(rows: T[]): T | undefined =>
  rows.find((r) => PROGRESS_TYPES.includes(r.notificationType ?? ""));

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
  if (action === "reversed") return "refunded";
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
function sendMembershipEmail(to: string, build: () => { subject: string; html: string }): void {
  try {
    const { subject, html } = build();
    Promise.resolve(sendEmail({ to, subject, html })).catch((err) =>
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
type StopResult = "stopped" | "already_inactive" | "failed";

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

async function deactivateAtEasypay(id: string): Promise<StopResult> {
  try {
    await easypayFetch(`/subscription/${id}`, { method: "PATCH", body: JSON.stringify({ status: "inactive" }) });
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

/** Easypay timestamps ("2026-10-07 14:06:15", no zone) as epoch ms; null when unreadable. */
function easypayTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const iso = value.trim().replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether `incoming` is older than the stored subscription `storedId`. Two timestamps in the
 * same format compare fine whatever their zone. Fails open (false: adopt) when either date
 * is missing or the stored one cannot be read, since keeping a card update out is worse than
 * the rare out-of-order pair this guards against.
 */
async function isOlderThanStored(incoming: EasypaySubscriptionResponse, storedId: string): Promise<boolean> {
  const incomingAt = easypayTime(incoming.created_at);
  if (incomingAt === null) return false;
  try {
    const stored = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${storedId}`);
    const storedAt = easypayTime(stored.created_at);
    return storedAt !== null && incomingAt < storedAt;
  } catch (err) {
    console.error(`[EASYPAY WEBHOOK] could not read stored subscription ${storedId} to compare ages:`, err);
    return false;
  }
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
  if (needsStop && (await isOlderThanStored(incoming, previous))) {
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
  const label = interval === "year" ? "Padmakara membership (yearly)" : "Padmakara membership (monthly)";

  const checkoutData = await easypayFetch<EasypayCheckoutResponse>("/checkout", {
    method: "POST",
    body: JSON.stringify({
      type: ["subscription"],
      payment: {
        methods: ["cc", "dd"],
        type: "sale",
        capture: {
          descriptive: "Padmakara membership",
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

  return c.json({ url: checkoutPageUrl });
});

const CHECKOUT_COPY = {
  en: {
    title: "Padmakara — Payment",
    update: "Update payment method",
    monthly: "Membership, monthly",
    yearly: "Membership, yearly",
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
    monthly: "Adesão mensal",
    yearly: "Adesão anual",
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

  // Never act on the request body — re-read the subscription from Easypay and trust
  // only what Easypay itself says about it.
  let subscription: EasypaySubscriptionResponse;
  try {
    subscription = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${id}`);
  } catch (err) {
    // Could be a notification about something that is not a subscription at all (the
    // `id` namespace differs per resource type). Recorded, not retried: we always
    // answer 200 so Easypay does not hammer us over something we will never handle.
    console.error(`[EASYPAY WEBHOOK] could not verify ${id}:`, err);
    await recordOutcome({ action: "unverified", note: String(err) });
    return c.json({ received: true });
  }

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

  // subscription_create is a stored card or a signed mandate, never money, so it is handled
  // before classifyNotification and can never reach the payment branch. Access waits for the
  // capture.
  if ((type ?? "").toLowerCase() === "subscription_create" && (status ?? "").toLowerCase() === "success") {
    const adoption = await adoptSubscription(user, id, subscription);
    if (adoption.outcome === "stale") {
      await recordOutcome({ ...common, action: "ignored", note: `create on replaced ${id}` });
      return c.json({ received: true });
    }
    // Whichever subscription had to be stopped (the old one on a card update, or the new
    // one that must not charge): if Easypay did not confirm, it would keep charging. Give
    // the claim back and fail, so Easypay retries this notification and the retry tries the
    // deactivation again. Nothing on the user row has changed yet, so the retry starts clean.
    if (adoption.outcome !== "current" && adoption.stop === "failed") {
      console.error(
        `[EASYPAY WEBHOOK] ${id} for user ${userId} (${adoption.outcome}) left a subscription that could not be stopped — answering 503 so Easypay retries`,
      );
      await db.delete(paymentTransactions).where(eq(paymentTransactions.id, txId));
      return c.json({ received: false, retry: true }, 503);
    }
    if (adoption.outcome === "discard") {
      await recordOutcome({
        ...common,
        action: adoption.reason === "cancelled" ? "replacement_cancelled" : "stale_replacement",
        note: `discarded ${id}${stopSuffix(adoption.stop)}`,
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

  const kind = classifyNotification(type, status);

  if (kind === "payment") {
    const expiresAt = nextExpiry(user.subscriptionExpiresAt, intervalFromFrequency(subscription.frequency as string | undefined));
    // Real access, not the stored status: a lapsed member still reads "active" and is
    // joining again, so they get the welcome.
    const wasActive = hasActiveSubscription(user);

    // Money arrived, so access is extended whatever happens to the subscription ids. A
    // capture can come before its subscription_create, so it may be the one that swaps
    // the new subscription in; a capture on one already replaced must not swap it back.
    const adoption = await adoptSubscription(user, id, subscription);
    let note: string | null = null;
    let idFields: Partial<Extract<Adoption, { outcome: "adopt" }>["fields"]> = {};
    if (adoption.outcome === "stale") {
      note = `capture on replaced ${id}`;
    } else if (adoption.outcome === "discard") {
      // The money is in, so access is extended, but this subscription is not the member's.
      note = `discarded ${id}${stopSuffix(adoption.stop)}`;
      if (adoption.stop === "failed") {
        console.error(
          `[EASYPAY WEBHOOK] user ${userId} paid through ${id}, which must not charge (${adoption.reason}), but it could not be stopped`,
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
            `[EASYPAY WEBHOOK] user ${userId} now pays through ${id}, but ${adoption.previous} could not be stopped and may charge again`,
          );
        }
      }
    }

    await db
      .update(users)
      .set({
        subscriptionStatus: "active",
        subscriptionSource: "easypay",
        ...idFields,
        subscriptionExpiresAt: expiresAt,
        subscriptionAmount: amount ?? user.subscriptionAmount,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await recordOutcome({ ...common, action: wasActive ? "extended" : "activated", note });
    if (!wasActive) {
      const interval = intervalFromFrequency(subscription.frequency as string | undefined);
      sendMembershipEmail(user.email, () =>
        buildWelcomeEmail({
          lang: emailLanguage(user.preferredLanguage),
          firstName: user.firstName,
          amount: Number(amount ?? user.subscriptionAmount ?? 0),
          interval,
          nextPaymentAt: expiresAt,
          manageUrl: membershipUrl(),
          retreatsUrl: `${config.urls.frontend}/`,
        }),
      );
    }
    console.log(
      `[EASYPAY WEBHOOK] user ${userId} paid ${amount ?? "?"} ${currency ?? ""} — access through ${expiresAt.toISOString()}`,
    );
    return c.json({ received: true });
  }

  if (kind === "reversal") {
    // The money went back. Close access now rather than at the paid-through date.
    await db
      .update(users)
      .set({ subscriptionStatus: "expired", updatedAt: new Date() })
      .where(eq(users.id, userId));

    await recordOutcome({ ...common, action: "reversed", note: `${type}/${status}` });
    console.log(`[EASYPAY WEBHOOK] ${type} for user ${userId} — access closed`);
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
  const firstPaymentFailed = !renewalFailed && !hasActiveSubscription(user) && !(await hasBeenPaidBefore(id));
  if (!renewalFailed && !firstPaymentFailed) return c.json({ received: true });

  // Easypay sends one failed notification per retry (`retries: 2`): one email per failure
  // episode is enough, so stay quiet if this subscription already had one lately.
  if (await alreadyToldAboutFailure(id, txId)) {
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

  const captures = rows.filter((r) => CAPTURE_TYPES.includes(r.notificationType ?? ""));
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
      const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${subId}`);
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
    checkout = await easypayFetch(`/checkout/${encodeURIComponent(c.req.param("id"))}`);
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
  await easypayFetch(`/subscription/${user.easypaySubscriptionId}`, {
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
  const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${subId}`);
  const parsed = parseContribution(body?.amount, intervalFromFrequency(sub.frequency));
  if (!parsed.ok) throw AppError.badRequest(parsed.error, "INVALID_CONTRIBUTION");

  await easypayFetch(`/subscription/${subId}`, {
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

  const sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${subId}`);
  // Inside the grace window the paid-through date is already past; Easypay needs a future start.
  const soonest = new Date(Date.now() + 5 * 60 * 1000);
  const restart =
    user.subscriptionExpiresAt && user.subscriptionExpiresAt > soonest ? user.subscriptionExpiresAt : soonest;
  await easypayFetch(`/subscription/${subId}`, {
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
    sub = await easypayFetch<EasypaySubscriptionResponse>(`/subscription/${subId}`);
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
  const label = interval === "year" ? "Padmakara membership (yearly)" : "Padmakara membership (monthly)";

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
  });
});

export { paymentRoutes };
