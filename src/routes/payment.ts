import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
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

// ─── Easypay API helpers ───

async function easypayFetch(path: string, options: RequestInit = {}) {
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
  return res.json();
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

function mockCancelSubscription(userId: number) {
  return db
    .update(users)
    .set({
      subscriptionStatus: "expired",
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

  const checkoutData = await easypayFetch("/checkout", {
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

  const body = await c.req.json();
  const { id, key, type, status } = body;

  console.log(`[EASYPAY WEBHOOK] type=${type} status=${status} id=${id} key=${key}`);

  if (!id) {
    return c.json({ received: true, ignored: true });
  }

  // Verify the notification by querying Easypay for subscription details
  try {
    const subscription = await easypayFetch(`/subscription/${id}`);

    // Extract userId from the order key (format: "user-{id}-{timestamp}")
    const orderKey = subscription.order?.key || key || "";
    const userIdMatch = orderKey.match(/^user-(\d+)/);
    if (!userIdMatch) {
      console.error(`[EASYPAY WEBHOOK] Cannot extract userId from key: ${orderKey}`);
      return c.json({ received: true, ignored: true });
    }

    const userId = parseInt(userIdMatch[1], 10);
    const subStatus = subscription.status;

    if (subStatus === "active") {
      // Calculate expiry from frequency (1M = 1 month from now per cycle)
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await db
        .update(users)
        .set({
          subscriptionStatus: "active",
          subscriptionSource: "easypay",
          easypaySubscriptionId: id,
          subscriptionExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      console.log(`[EASYPAY WEBHOOK] Subscription activated for user ${userId}`);
    } else if (subStatus === "inactive" || subStatus === "deleted") {
      await db
        .update(users)
        .set({
          subscriptionStatus: "expired",
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      console.log(`[EASYPAY WEBHOOK] Subscription cancelled for user ${userId}`);
    }
  } catch (err) {
    // If we can't verify, log but don't fail — Easypay will retry
    console.error(`[EASYPAY WEBHOOK] Failed to verify notification ${id}:`, err);
  }

  return c.json({ received: true });
});

/**
 * POST /api/payment/cancel
 * Cancels the user's Easypay subscription.
 * In mock mode: marks subscription as expired directly.
 */
paymentRoutes.post("/cancel", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  if (!user) throw AppError.notFound("User not found");

  if (isMockMode) {
    console.log(`[MOCK PAYMENT] Cancelling subscription for user ${user.id}`);
    await mockCancelSubscription(user.id);
    return c.json({ url: `${config.urls.frontend}/subscription/cancel` });
  }

  if (!user.easypaySubscriptionId) {
    throw AppError.badRequest("No Easypay subscription found for this account");
  }

  // Cancel subscription via Easypay API
  await easypayFetch(`/subscription/${user.easypaySubscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "inactive" }),
  });

  await db
    .update(users)
    .set({
      subscriptionStatus: "expired",
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ url: `${config.urls.frontend}/subscription/cancel` });
});

export { paymentRoutes };
