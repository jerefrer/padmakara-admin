import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { paymentTransactions } from "../db/schema/payment-transactions.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";

const EASYPAY_API_BASE = config.easypay.testing
  ? "https://api.test.easypay.pt/2.0"
  : "https://api.prod.easypay.pt/2.0";

const EASYPAY_CHECKOUT_SDK = "https://cdn.easypay.pt/checkout/2.9.0/";

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
const PAYMENT_TYPES = new Set(["capture", "payment", "subscription"]);
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

/**
 * Extend from the later of now and the current paid-through date: a renewal that
 * arrives early must not shorten the period already paid for, and one that arrives
 * late must not quietly swallow the days it was late by.
 */
function nextExpiry(current: Date | null): Date {
  const now = new Date();
  const base = current && current > now ? new Date(current) : now;
  base.setMonth(base.getMonth() + 1);
  return base;
}

// ─── Easypay API helpers ───

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
    throw AppError.internal(`Easypay API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Mock mode helpers ───

function mockCreateSubscription(userId: number) {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return db
    .update(users)
    .set({
      subscriptionStatus: "active",
      subscriptionSource: "easypay",
      easypaySubscriptionId: `mock_sub_${userId}`,
      subscriptionExpiresAt: expiresAt,
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

  if (user.subscriptionStatus === "active") {
    throw AppError.badRequest("You already have an active subscription");
  }

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Activating subscription for user ${user.id}`);
    await mockCreateSubscription(user.id);
    return c.json({
      url: `${config.urls.frontend}/subscription/success?session_id=mock_session`,
    });
  }

  // Create Easypay checkout session
  const now = new Date();
  now.setMinutes(now.getMinutes() + 5); // Start 5 min from now
  const startTime = now.toISOString().replace("T", " ").slice(0, 16);

  const checkoutData = await easypayFetch<EasypayCheckoutResponse>("/checkout", {
    method: "POST",
    body: JSON.stringify({
      type: ["subscription"],
      payment: {
        methods: ["cc", "dd"],
        type: "sale",
        capture: {
          descriptive: "Padmakara — Monthly Subscription",
        },
        currency: "EUR",
        start_time: startTime,
        frequency: "1M",
        expiration_time: "2030-12-31 23:59",
        capture_now: true,
        retries: 2,
      },
      order: {
        items: [
          {
            description: "Padmakara Monthly Subscription",
            quantity: 1,
            key: `padmakara-monthly-user-${user.id}`,
            value: 5,
          },
        ],
        key: `user-${user.id}-${Date.now()}`,
        value: 5,
      },
      customer: {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
        email: user.email,
        phone_indicative: "+351",
        key: `user-${user.id}`,
      },
    }),
  });

  // Store the checkout session id so we can link it back in the webhook
  // The checkout page URL includes the manifest session for the SDK
  const checkoutPageUrl = `${config.urls.backend}/api/payment/checkout/${checkoutData.id}?session=${encodeURIComponent(checkoutData.session)}&userId=${user.id}`;

  return c.json({ url: checkoutPageUrl });
});

/**
 * GET /api/payment/checkout/:id
 * Serves an HTML page that embeds the Easypay checkout SDK.
 * This page is opened by the mobile app or web browser.
 */
paymentRoutes.get("/checkout/:id", async (c) => {
  const session = c.req.query("session");
  const userId = c.req.query("userId");

  if (!session) {
    return c.text("Missing checkout session", 400);
  }

  const successUrl = `${config.urls.frontend}/subscription/success?session_id=${c.req.param("id")}`;
  const cancelUrl = `${config.urls.frontend}/subscription/cancel`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Padmakara — Payment</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fcf8f3; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    h2 { color: #5B5EA6; margin-bottom: 8px; font-size: 1.4rem; }
    p { color: #666; margin-bottom: 20px; font-size: 0.9rem; }
    #easypay-checkout { min-height: 400px; }
    .error { color: #b91c1c; text-align: center; margin-top: 20px; }
    .error-detail { color: #888; font-size: 0.8rem; margin-top: 8px; }
  </style>
</head>
<body>
  <h2>Padmakara</h2>
  <p>Complete your subscription payment</p>
  <div id="easypay-checkout"></div>
  <script src="${EASYPAY_CHECKOUT_SDK}"></script>
  <script>
    var manifest = ${JSON.stringify({ id: c.req.param("id"), session })};
    console.log('Checkout manifest:', manifest);
    console.log('Testing mode:', ${config.easypay.testing});
    easypayCheckout.startCheckout(manifest, {
      id: 'easypay-checkout',
      display: 'inline',
      testing: ${config.easypay.testing},
      onSuccess: function(successInfo) {
        console.log('Payment success:', successInfo);
        window.location.href = ${JSON.stringify(successUrl)};
      },
      onPaymentError: function(error) {
        console.warn('Payment error (retryable):', JSON.stringify(error));
      },
      onError: function(error) {
        console.error('Checkout error (fatal):', JSON.stringify(error));
        var detail = error && error.code ? error.code : JSON.stringify(error);
        document.getElementById('easypay-checkout').innerHTML =
          '<p class="error">Payment failed. Please try again.</p>' +
          '<p class="error-detail">Error: ' + detail + '</p>';
      },
      onClose: function() {
        window.location.href = ${JSON.stringify(cancelUrl)};
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

  const kind = classifyNotification(type, status);
  const common = { userId, rawSubscription: subscription, amount, currency };

  if (kind === "payment") {
    const expiresAt = nextExpiry(user.subscriptionExpiresAt);
    const wasActive = user.subscriptionStatus === "active";

    await db
      .update(users)
      .set({
        subscriptionStatus: "active",
        subscriptionSource: "easypay",
        easypaySubscriptionId: id,
        subscriptionExpiresAt: expiresAt,
        subscriptionAmount: amount ?? user.subscriptionAmount,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await recordOutcome({ ...common, action: wasActive ? "extended" : "activated" });
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
  return c.json({ received: true });
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

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Cancelling subscription for user ${user.id}`);
    await mockCancelSubscription(user.id);
    return c.json({ url: `${config.urls.frontend}/subscription/cancel`, accessUntil });
  }

  if (!user.easypaySubscriptionId) {
    throw AppError.badRequest("No Easypay subscription found for this account");
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

  return c.json({ url: `${config.urls.frontend}/subscription/cancel`, accessUntil });
});

export { paymentRoutes };
