import { Hono, type Context } from "hono";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, userGroupMemberships } from "../db/schema/users.ts";
import {
  refreshTokens,
  magicLinkTokens,
  accountDeletionTokens,
  deviceActivations,
} from "../db/schema/auth.ts";
import {
  hashPassword,
  verifyPassword,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  generateMagicLinkToken,
  hashToken,
  magicLinkExpiresAt,
  refreshTokenExpiresAt,
  type TokenPayload,
} from "../services/auth.ts";
import { hasActiveSubscription } from "../services/access.ts";
import {
  sendEmail,
  buildMagicLinkEmail,
  buildAccountDeletionEmail,
  buildBackofficeCodeEmail,
} from "../services/email.ts";
import { AppError } from "../lib/errors.ts";
import { escapeHtml, type Lang } from "../services/email-template.ts";
import {
  loginSchema,
  requestMagicLinkSchema,
  reviewLoginSchema,
  verifyCodeSchema,
  backofficeCodeRequestSchema,
  backofficeCodeVerifySchema,
  refreshTokenSchema,
  discoverDeviceSchema,
  autoActivateSchema,
  deactivateDeviceSchema,
  requestAccountDeletionSchema,
  confirmAccountDeletionSchema,
} from "../lib/schemas.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { config } from "../config.ts";
import { activateDeviceForUser } from "../services/device-activation.ts";
import { accountForEmailSignIn } from "../services/sign-in-account.ts";
import { isReviewLoginFor, verifyReviewCode } from "../services/review-account.ts";
import { generateSignInCode, hashSignInCode } from "../services/sign-in-code.ts";
import { claimSignInCode } from "../services/sign-in-code-claim.ts";
import { deleteUserAccount } from "../services/account-deletion.ts";
import { hashDeviceFingerprint, isCurrentFingerprintFormat } from "../lib/device-fingerprint.ts";
import {
  authIpLimiter,
  authEmailLimiter,
  discoverIpLimiter,
} from "../middleware/rate-limit.ts";

const auth = new Hono();

/** `hasAccess` is the real entitlement (grace days included); status alone can be stale. */
function subscriptionForApp(user: {
  subscriptionStatus: string;
  subscriptionSource: string | null;
  subscriptionExpiresAt: Date | null;
  subscriptionCancelledAt: Date | null;
  subscriptionAmount: string | null;
}) {
  return {
    status: user.subscriptionStatus as "active" | "expired" | "none",
    source: user.subscriptionSource,
    expiresAt: user.subscriptionExpiresAt?.toISOString() || null,
    cancelledAt: user.subscriptionCancelledAt?.toISOString() || null,
    amount: user.subscriptionAmount === null || user.subscriptionAmount === undefined ? null : Number(user.subscriptionAmount),
    hasAccess: hasActiveSubscription(user),
  };
}

/**
 * Format a user record for the mobile app's expected shape.
 * The app stores this as the User object in AsyncStorage.
 */
export async function formatUserForApp(user: {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  dharmaName: string | null;
  preferredLanguage: string;
  role: string;
  isActive: boolean;
  isVerified: boolean;
  subscriptionStatus: string;
  subscriptionSource: string | null;
  subscriptionExpiresAt: Date | null;
  subscriptionCancelledAt: Date | null;
  subscriptionAmount: string | null;
  lastActivity: Date | null;
  createdAt: Date;
}) {
  const firstName = user.firstName || "";
  const lastName = user.lastName || "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || user.email;

  // Fetch user's group memberships
  const userGroups = await db.query.userGroupMemberships.findMany({
    where: eq(userGroupMemberships.userId, user.id),
  });

  return {
    id: String(user.id),
    name,
    first_name: firstName,
    last_name: lastName,
    email: user.email,
    avatar: null,
    dharma_name: user.dharmaName || undefined,
    retreat_groups: userGroups.map((ug) => String(ug.retreatGroupId)),
    preferences: {
      language: user.preferredLanguage as "en" | "pt",
      contentLanguage: "en" as const,
      biometricEnabled: false,
      notifications: true,
    },
    subscription: subscriptionForApp(user),
    created_at: user.createdAt.toISOString(),
    last_login: user.lastActivity?.toISOString() || user.createdAt.toISOString(),
  };
}

/**
 * Generate JWT tokens + store refresh token for a user.
 */
export async function generateTokensForUser(user: { id: number; email: string; role: string }) {
  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };

  const [accessToken, refreshTokenValue] = await Promise.all([
    createAccessToken(payload),
    createRefreshToken(payload),
  ]);

  const rtHash = await hashToken(refreshTokenValue);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: rtHash,
    expiresAt: refreshTokenExpiresAt(),
  });

  return { accessToken, refreshToken: refreshTokenValue };
}

// ──────────────────────────────────────────────────────
// Admin login (email + password) — used by React-admin UI
// ──────────────────────────────────────────────────────

/**
 * POST /api/auth/login - Admin login with email + password
 */
auth.post("/login", authIpLimiter(), authEmailLimiter(), async (c) => {
  const body = await c.req.json();
  const data = loginSchema.parse(body);

  const user = await db.query.users.findFirst({
    where: eq(users.email, data.email),
  });

  if (!user || !user.passwordHash) {
    throw AppError.unauthorized("Invalid email or password");
  }

  if (!user.isActive) {
    throw AppError.unauthorized("Account is deactivated");
  }

  const valid = await verifyPassword(data.password, user.passwordHash);
  if (!valid) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const tokens = await generateTokensForUser(user);

  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
});

// ──────────────────────────────────────────────────────
// Backoffice sign-in by emailed code — used by React-admin UI
// ──────────────────────────────────────────────────────

/**
 * Accounts made in the app have no password, so an admin signs in to the
 * backoffice with a 6-digit code sent by email, like in the app. The code is
 * bound to the page that asked for it through a random challenge id (stored as
 * the token's device fingerprint, hashed like any other), so a code read off
 * the email works nowhere else. No device is activated: the backoffice only
 * gets tokens.
 */
const BACKOFFICE_FINGERPRINT_PREFIX = "backoffice:";

function isActiveAdmin(user: { role: string; isActive: boolean } | undefined | null): boolean {
  return !!user && user.isActive && (user.role === "admin" || user.role === "superadmin");
}

/**
 * POST /api/auth/backoffice/request-code
 *
 * Always answers with a fresh challenge id, admin or not, so the response
 * does not reveal who has backoffice access; only an active admin gets an email.
 */
auth.post("/backoffice/request-code", authIpLimiter(), authEmailLimiter(), async (c) => {
  const data = backofficeCodeRequestSchema.parse(await c.req.json());
  const email = data.email.toLowerCase().trim();
  const challengeId = generateMagicLinkToken();

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!isActiveAdmin(user)) return c.json({ challengeId });

  const code = generateSignInCode();
  await db.insert(magicLinkTokens).values({
    email,
    // The row's link is never sent; it only holds the code.
    tokenHash: await hashToken(generateMagicLinkToken()),
    expiresAt: magicLinkExpiresAt(),
    deviceFingerprint: hashDeviceFingerprint(`${BACKOFFICE_FINGERPRINT_PREFIX}${challengeId}`),
    deviceName: "Backoffice",
    deviceType: "web",
    language: data.language,
    codeHash: hashSignInCode(code),
  });
  await sendEmail({ to: email, ...buildBackofficeCodeEmail(code, data.language) });

  return c.json({ challengeId });
});

/**
 * POST /api/auth/backoffice/verify-code
 *
 * Same success shape as /login. Every failure (not an active admin, wrong,
 * expired or used code, other challenge, attempts exhausted) is the same 401.
 */
auth.post("/backoffice/verify-code", authIpLimiter(), authEmailLimiter(), async (c) => {
  const data = backofficeCodeVerifySchema.parse(await c.req.json());
  const email = data.email.toLowerCase().trim();
  const fail = () => AppError.unauthorized("Invalid or expired code");

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user || !isActiveAdmin(user)) throw fail();

  const claimed = await claimSignInCode(
    email,
    `${BACKOFFICE_FINGERPRINT_PREFIX}${data.challengeId}`,
    data.code,
  );
  if (!claimed) throw fail();

  const tokens = await generateTokensForUser(user);
  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
});

// ──────────────────────────────────────────────────────
// Device-based magic link auth — used by React Native app
// ──────────────────────────────────────────────────────

/** How long an activated device may sign back in without an email (user decision, 2026-11-16). */
const SIGN_BACK_IN_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * An activated device signs back in without email only with a fingerprint in
 * the current format (random, kept in secure storage) and only if it was used
 * within the last 12 months. Legacy fingerprints (weak, in plain storage) and
 * older activations go through the email instead; they keep working everywhere
 * else.
 */
function mayReturnWithoutEmail(fingerprint: string, device: { lastUsed: Date }): boolean {
  return (
    isCurrentFingerprintFormat(fingerprint) &&
    device.lastUsed.getTime() > Date.now() - SIGN_BACK_IN_WINDOW_MS
  );
}

/**
 * POST /api/auth/request-magic-link
 *
 * Step 1 of mobile auth. The app sends email + device info.
 * - If user exists & device already activated → return tokens immediately,
 *   within the limits of mayReturnWithoutEmail
 * - If user exists but device not activated → send magic link email
 * - If user doesn't exist → send magic link email too; the account is created
 *   when the link or code is used (see accountForEmailSignIn)
 * - If the account is deactivated → no email, same response as a sent one
 */
auth.post("/request-magic-link", authIpLimiter(), authEmailLimiter(), async (c) => {
  const body = await c.req.json();
  const data = requestMagicLinkSchema.parse(body);

  const email = data.email.toLowerCase().trim();
  const fingerprintHash = hashDeviceFingerprint(data.device_fingerprint);

  // Look up user
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (user && !user.isActive) {
    // Same body as a sent link, so the response does not reveal that this
    // address has a deactivated account.
    return c.json({
      status: "magic_link_sent",
      message: "Please check your email",
      expires_in: 3600,
    });
  }

  // Check if this device is already activated for this user
  const existingDevice = user
    ? await db.query.deviceActivations.findFirst({
        where: and(
          eq(deviceActivations.deviceFingerprint, fingerprintHash),
          eq(deviceActivations.userId, user.id),
          eq(deviceActivations.isActive, true),
        ),
      })
    : undefined;

  if (user && existingDevice && mayReturnWithoutEmail(data.device_fingerprint, existingDevice)) {
    // Device already activated — return tokens directly
    const tokens = await generateTokensForUser(user);

    await db
      .update(deviceActivations)
      .set({ lastUsed: new Date() })
      .where(eq(deviceActivations.id, existingDevice.id));

    await db
      .update(users)
      .set({ lastActivity: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return c.json({
      status: "already_activated",
      message: "Device is already activated",
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user: await formatUserForApp(user),
    });
  }

  // Store-review demo account: no email, the app asks for the review code and
  // calls /review-login. Only for an existing, active review user.
  if (user && isReviewLoginFor(email)) {
    return c.json({
      status: "code_required",
      message: "Enter the review code to sign in",
    });
  }

  // Device not activated, or no account yet — create magic link and send email
  const token = generateMagicLinkToken();
  const tokenHash = await hashToken(token);
  // Same row as the link: whichever is used first consumes the other.
  const signInCode = generateSignInCode();

  await db.insert(magicLinkTokens).values({
    email,
    tokenHash,
    expiresAt: magicLinkExpiresAt(),
    deviceFingerprint: fingerprintHash,
    deviceName: data.device_name,
    deviceType: data.device_type,
    language: data.language ?? "en",
    codeHash: hashSignInCode(signInCode),
  });

  // Build activation URL (points to backend, which renders HTML)
  const magicLinkUrl = `${config.urls.backend}/api/auth/activate/${token}?lang=${data.language}`;
  const emailContent = buildMagicLinkEmail(magicLinkUrl, data.language ?? "en", signInCode);

  await sendEmail({
    to: email,
    ...emailContent,
  });

  const response: Record<string, unknown> = {
    status: "magic_link_sent",
    message: "Please check your email",
    expires_in: 3600,
  };

  // In dev mode, log the activation URL prominently so you can click it
  if (config.isDev) {
    response.dev_activation_url = magicLinkUrl;
    response.dev_sign_in_code = signInCode;
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  🔑 DEV: Click to activate device            ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`  ${magicLinkUrl}\n`);
  }

  return c.json(response);
});

type MagicLinkToken = typeof magicLinkTokens.$inferSelect;

/** `?lang=` first, then the language stored on the token, then English. */
function activationLang(queryLang: string | undefined, token: MagicLinkToken | undefined): Lang {
  return (queryLang || token?.language || "en") === "pt" ? "pt" : "en";
}

/** The unused, unexpired token behind a link, or undefined. */
async function findUsableMagicLink(token: string): Promise<MagicLinkToken | undefined> {
  const now = new Date();
  const magicLink = await db.query.magicLinkTokens.findFirst({
    where: and(
      eq(magicLinkTokens.tokenHash, await hashToken(token)),
      eq(magicLinkTokens.isUsed, false),
      gt(magicLinkTokens.expiresAt, now),
    ),
  });
  // The query already filters; re-check so a bug there cannot widen the match.
  if (!magicLink || magicLink.isUsed || magicLink.expiresAt <= now) return undefined;
  return magicLink;
}

/**
 * An admin token opens the whole backoffice API, so for admin and superadmin
 * accounts the emailed link never activates a device: only the code, typed on
 * the device that asked for it, signs them in.
 */
async function isAdminEmail(email: string): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  return !!user && (user.role === "admin" || user.role === "superadmin");
}

/** The page carries a live sign-in link: never cache it, never leak its URL. */
function activationResponse(c: Context, page: ActivationPage) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return c.html(renderActivationPage(page));
}

function invalidLinkPage(lang: Lang): ActivationPage {
  return {
    lang,
    kind: "error",
    title: lang === "pt" ? "Link Inválido" : "Invalid Link",
    message: lang === "pt"
      ? "Este link é inválido ou já expirou. Por favor solicite um novo link na aplicação."
      : "This link is invalid or has expired. Please request a new link in the app.",
  };
}

function useCodeInsteadPage(lang: Lang): ActivationPage {
  return {
    lang,
    kind: "info",
    title: lang === "pt" ? "Por favor use o código" : "Please use the code",
    message: lang === "pt"
      ? "Nesta conta, o link não pode ser usado para entrar. Introduza o código de 6 dígitos do mesmo email na aplicação ou no site."
      : "For this account, the link cannot be used to sign in. Please enter the 6-digit code from the same email in the app or on the website.",
  };
}

const DEVICE_TYPE_LABELS: Record<string, Record<Lang, string>> = {
  ios: { en: "iPhone or iPad", pt: "iPhone ou iPad" },
  android: { en: "Android", pt: "Android" },
  web: { en: "web browser", pt: "navegador de internet" },
};

function confirmSignInPage(lang: Lang, magicLink: MagicLinkToken, action: string): ActivationPage {
  const typeLabel = DEVICE_TYPE_LABELS[magicLink.deviceType ?? ""]?.[lang];
  const type = typeLabel ? ` (${typeLabel})` : "";
  const name = magicLink.deviceName?.trim();
  const device = lang === "pt"
    ? (name ? `O dispositivo “${name}”${type}` : `Um dispositivo${type}`)
    : (name ? `The device “${name}”${type}` : `A device${type}`);
  return {
    lang,
    kind: "confirm",
    title: lang === "pt" ? "Entrar na Padmakara?" : "Sign in to Padmakara?",
    message: lang === "pt"
      ? `${device} está a pedir para entrar na Padmakara com o email ${magicLink.email}.`
      : `${device} is asking to sign in to Padmakara with the email ${magicLink.email}.`,
    confirm: {
      action,
      button: lang === "pt" ? "Sim, entrar" : "Yes, sign me in",
      note: lang === "pt"
        ? "Se não pediu para entrar, basta fechar esta página."
        : "If you did not ask to sign in, simply close this page.",
    },
  };
}

/**
 * GET /api/auth/activate/:token
 *
 * Opened from the magic link in the email. Changes nothing: mail scanners and
 * link previews fetch this URL too, so it only renders a page asking the person
 * to confirm, whose button POSTs back to the same URL.
 */
auth.get("/activate/:token", async (c) => {
  const token = c.req.param("token");
  const magicLink = await findUsableMagicLink(token);
  const lang = activationLang(c.req.query("lang"), magicLink);

  if (!magicLink) return activationResponse(c, invalidLinkPage(lang));
  if (await isAdminEmail(magicLink.email)) return activationResponse(c, useCodeInsteadPage(lang));

  const action = `/api/auth/activate/${encodeURIComponent(token)}?lang=${lang}`;
  return activationResponse(c, confirmSignInPage(lang, magicLink, action));
});

/**
 * POST /api/auth/activate/:token
 *
 * The confirmation page's button. Consumes the token, creates the account on a
 * first sign-in, activates the device stored with the token and renders the
 * success page. The mobile app discovers this activation via /device/discover.
 */
auth.post("/activate/:token", async (c) => {
  const token = c.req.param("token");
  const magicLink = await findUsableMagicLink(token);
  const lang = activationLang(c.req.query("lang"), magicLink);

  if (!magicLink) return activationResponse(c, invalidLinkPage(lang));
  // Left unused, so the code from the same email still works.
  if (await isAdminEmail(magicLink.email)) return activationResponse(c, useCodeInsteadPage(lang));

  // Consume atomically: of two concurrent confirmations only one activates.
  const consumed = await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(
      and(
        eq(magicLinkTokens.id, magicLink.id),
        eq(magicLinkTokens.isUsed, false),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning({ id: magicLinkTokens.id });
  if (consumed.length === 0) return activationResponse(c, invalidLinkPage(lang));

  // Find the user, or create the account on a first sign-in
  const user = await accountForEmailSignIn(magicLink.email, magicLink.language);

  if (!user) {
    return activationResponse(c, {
      lang,
      kind: "error",
      title: lang === "pt" ? "Conta Não Encontrada" : "Account Not Found",
      message: lang === "pt"
        ? "Não foi possível encontrar a sua conta. Por favor contacte o suporte."
        : "Your account could not be found. Please contact support.",
    });
  }

  // Mark user as verified
  if (!user.isVerified) {
    await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  // Create or reactivate device activation. The token row already holds the
  // fingerprint's hash: it is copied as it is, never hashed again.
  // The tokens reach the app through /device/discover, once (pendingClaim).
  if (magicLink.deviceFingerprint) {
    const existingDevice = await db.query.deviceActivations.findFirst({
      where: eq(deviceActivations.deviceFingerprint, magicLink.deviceFingerprint),
    });

    if (existingDevice) {
      // Reactivate existing device
      await db
        .update(deviceActivations)
        .set({
          isActive: true,
          userId: user.id,
          deviceName: magicLink.deviceName || existingDevice.deviceName,
          deviceType: magicLink.deviceType || existingDevice.deviceType,
          lastUsed: new Date(),
          ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
          userAgent: c.req.header("user-agent") || null,
          pendingClaim: true,
        })
        .where(eq(deviceActivations.id, existingDevice.id));
    } else {
      // Create new device activation
      await db.insert(deviceActivations).values({
        userId: user.id,
        deviceFingerprint: magicLink.deviceFingerprint,
        deviceName: magicLink.deviceName || "Unknown Device",
        deviceType: magicLink.deviceType || "unknown",
        ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
        userAgent: c.req.header("user-agent") || null,
        pendingClaim: true,
      });
    }
  }

  // Update user last activity
  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return activationResponse(c, {
    lang,
    kind: "success",
    title: lang === "pt" ? "Dispositivo Ativado" : "Device Activated",
    message: lang === "pt"
      ? "O seu dispositivo foi ativado com sucesso! Pode voltar à aplicação."
      : "Your device has been activated successfully! You can return to the app.",
  });
});

/**
 * POST /api/auth/device/discover
 *
 * Polling endpoint. The mobile app calls this every few seconds after
 * requesting a magic link to check if the device was activated
 * (by the user confirming the link in their email).
 *
 * A one-time claim: tokens only come back while the activation is
 * `pendingClaim` (set by POST /activate/:token), and the same UPDATE ...
 * RETURNING clears it, so of two concurrent polls only one gets tokens. Every
 * other case is the plain `not_activated` answer: the fingerprint alone no
 * longer turns into a session.
 */
auth.post("/device/discover", discoverIpLimiter(), async (c) => {
  const body = await c.req.json();
  const data = discoverDeviceSchema.parse(body);

  const [device] = await db
    .update(deviceActivations)
    .set({ pendingClaim: false, lastUsed: new Date() })
    .where(
      and(
        eq(deviceActivations.deviceFingerprint, hashDeviceFingerprint(data.device_fingerprint)),
        eq(deviceActivations.isActive, true),
        eq(deviceActivations.pendingClaim, true),
      ),
    )
    .returning();

  if (!device) {
    return c.json({
      status: "not_activated",
      message: "Device not activated yet",
    });
  }

  // Device is activated — get user and generate tokens
  const user = await db.query.users.findFirst({
    where: eq(users.id, device.userId),
  });

  if (!user || !user.isActive) {
    return c.json({
      status: "not_activated",
      message: "Device not activated yet",
    });
  }

  const tokens = await generateTokensForUser(user);

  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({
    status: "activated",
    message: "Device is activated",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: await formatUserForApp(user),
    device: {
      activated_at: device.activatedAt.toISOString(),
      device_fingerprint: device.deviceFingerprint,
      device_name: device.deviceName,
      user_name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      is_active: device.isActive,
    },
  });
});

/**
 * POST /api/auth/auto-activate
 *
 * Auto-activate a device using a magic link token directly
 * (for deep link / in-app activation flow).
 */
auth.post("/auto-activate", authIpLimiter(), async (c) => {
  const body = await c.req.json();
  const data = autoActivateSchema.parse(body);
  const fail = () => AppError.unauthorized("Invalid or expired token");

  const magicLink = await findUsableMagicLink(data.token);
  if (!magicLink) throw fail();

  // Admins sign in only with the code: refuse with the same 401 as a bad
  // token, so the answer does not reveal the role, and leave the token
  // unused so the code from the same email still works.
  if (await isAdminEmail(magicLink.email)) throw fail();

  // Consume atomically: of two concurrent requests only one activates.
  const consumed = await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(
      and(
        eq(magicLinkTokens.id, magicLink.id),
        eq(magicLinkTokens.isUsed, false),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning({ id: magicLinkTokens.id });
  if (consumed.length === 0) throw fail();

  // Find the user, or create the account on a first sign-in
  const user = await accountForEmailSignIn(magicLink.email, magicLink.language);

  if (!user) {
    throw AppError.unauthorized("Account not found or deactivated");
  }

  await activateDeviceForUser(user, {
    fingerprint: data.device_fingerprint,
    name: data.device_name,
    type: data.device_type,
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  });

  const tokens = await generateTokensForUser(user);

  return c.json({
    status: "device_activated",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: await formatUserForApp(user),
    device_activation: {
      device_name: data.device_name,
      device_type: data.device_type,
      activated_at: new Date().toISOString(),
    },
  });
});

/**
 * POST /api/auth/review-login
 *
 * Store-review demo account sign-in: same device fields as request-magic-link
 * plus the review `code`. On success the device is activated exactly like a
 * clicked magic link and the response has the same shape as the
 * "already activated" branch of request-magic-link. Every failure (wrong code,
 * feature disabled, any other email, missing/inactive user) is the same generic
 * 401 so nothing about the account or the configuration leaks. The code is
 * never logged.
 */
auth.post("/review-login", authIpLimiter(), authEmailLimiter(), async (c) => {
  const body = await c.req.json();
  const data = reviewLoginSchema.parse(body);
  const email = data.email.toLowerCase().trim();

  // Evaluate both checks unconditionally so timing does not reveal which failed.
  const emailOk = isReviewLoginFor(email);
  const codeOk = verifyReviewCode(data.code);
  if (!emailOk || !codeOk) {
    throw AppError.unauthorized("Invalid review credentials");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!user || !user.isActive) {
    throw AppError.unauthorized("Invalid review credentials");
  }

  await activateDeviceForUser(user, {
    fingerprint: data.device_fingerprint,
    name: data.device_name,
    type: data.device_type,
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  });

  const tokens = await generateTokensForUser(user);

  return c.json({
    status: "already_activated",
    message: "Device is activated",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: await formatUserForApp(user),
  });
});

/**
 * POST /api/auth/verify-code
 *
 * Alternative to clicking the magic link: the person types the 6-digit code from
 * the same email on the device that requested it. The code lives on the link's
 * own row, so using either one consumes the other. It is bound to the requesting
 * device fingerprint and allows MAX_CODE_ATTEMPTS wrong guesses per token. Every
 * failure (unknown email, inactive user, no candidate row, wrong code, attempts
 * exhausted, expired, used, other device) is the same generic 401. The code is
 * never logged. Success has the same shape as review-login.
 */
auth.post("/verify-code", authIpLimiter(), authEmailLimiter(), async (c) => {
  const body = await c.req.json();
  const data = verifyCodeSchema.parse(body);
  const email = data.email.toLowerCase().trim();
  const fail = () => AppError.unauthorized("Invalid or expired code");

  // An address with no account yet may sign in; its account is created only
  // once the code is right.
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing && !existing.isActive) throw fail();

  const matched = await claimSignInCode(email, data.device_fingerprint, data.code);
  if (!matched) throw fail();

  const user = await accountForEmailSignIn(email, matched.language);
  if (!user) throw fail();

  await activateDeviceForUser(user, {
    fingerprint: data.device_fingerprint,
    name: data.device_name,
    type: data.device_type,
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  });

  const tokens = await generateTokensForUser(user);

  return c.json({
    status: "already_activated",
    message: "Device is activated",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    user: await formatUserForApp(user),
  });
});

/**
 * POST /api/auth/device/deactivate
 *
 * Deactivate a device (used by "Forget Device" in the app).
 * Requires authentication.
 */
auth.post("/device/deactivate", authMiddleware, async (c) => {
  const authUser = getUser(c);
  const body = await c.req.json();
  const data = deactivateDeviceSchema.parse(body);

  const device = await db.query.deviceActivations.findFirst({
    where: and(
      eq(deviceActivations.deviceFingerprint, hashDeviceFingerprint(data.device_fingerprint)),
      eq(deviceActivations.userId, authUser.id),
    ),
  });

  if (!device) {
    return c.json({
      status: "not_found",
      message: "Device not found",
    });
  }

  await db
    .update(deviceActivations)
    .set({ isActive: false })
    .where(eq(deviceActivations.id, device.id));

  return c.json({
    status: "deactivated",
    message: "Device has been deactivated",
  });
});

/**
 * GET /api/auth/devices
 *
 * List all active devices for the authenticated user.
 * Also used by the mobile app for token validation (if 200 → token is valid).
 */
auth.get("/devices", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const devices = await db.query.deviceActivations.findMany({
    where: and(
      eq(deviceActivations.userId, authUser.id),
      eq(deviceActivations.isActive, true),
    ),
  });

  return c.json(
    devices.map((d) => ({
      id: d.id,
      device_fingerprint: d.deviceFingerprint,
      device_name: d.deviceName,
      device_type: d.deviceType,
      activated_at: d.activatedAt.toISOString(),
      last_used: d.lastUsed.toISOString(),
      is_active: d.isActive,
    })),
  );
});

// ──────────────────────────────────────────────────────
// User profile endpoints — used by mobile app
// ──────────────────────────────────────────────────────

/**
 * GET /api/auth/user
 *
 * Get current user profile in the format the mobile app expects.
 */
auth.get("/user", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });

  if (!user) {
    throw AppError.notFound("User not found");
  }

  return c.json(await formatUserForApp(user));
});

/**
 * PATCH /api/auth/user
 *
 * Update user profile. Used by the mobile app for preferences, biometric, etc.
 */
auth.patch("/user", authMiddleware, async (c) => {
  const authUser = getUser(c);
  const body = await c.req.json();

  // Extract fields the app may send
  const {
    first_name,
    last_name,
    firstName,
    lastName,
    dharma_name,
    dharmaName,
    preferences,
  } = body as {
    first_name?: string;
    last_name?: string;
    firstName?: string;
    lastName?: string;
    dharma_name?: string;
    dharmaName?: string;
    preferences?: {
      language?: string;
      contentLanguage?: string;
      biometricEnabled?: boolean;
      notifications?: boolean;
    };
  };

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (first_name !== undefined || firstName !== undefined)
    updateData.firstName = first_name ?? firstName;
  if (last_name !== undefined || lastName !== undefined)
    updateData.lastName = last_name ?? lastName;
  if (dharma_name !== undefined || dharmaName !== undefined)
    updateData.dharmaName = dharma_name ?? dharmaName;
  if (preferences?.language)
    updateData.preferredLanguage = preferences.language;

  const [updatedUser] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, authUser.id))
    .returning();

  if (!updatedUser) {
    throw AppError.notFound("User not found");
  }

  return c.json(await formatUserForApp(updatedUser));
});

// ──────────────────────────────────────────────────────
// Token refresh & logout (shared by admin + mobile)
// ──────────────────────────────────────────────────────

/**
 * POST /api/auth/refresh - Exchange refresh token for new access token
 */
auth.post("/refresh", async (c) => {
  const body = await c.req.json();
  const data = refreshTokenSchema.parse(body);

  let jwtPayload;
  try {
    jwtPayload = await verifyToken(data.refreshToken);
  } catch {
    throw AppError.unauthorized("Invalid refresh token");
  }

  const tokenHash = await hashToken(data.refreshToken);

  const storedToken = await db.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.tokenHash, tokenHash),
      gt(refreshTokens.expiresAt, new Date()),
    ),
  });

  if (!storedToken) {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, storedToken.userId),
  });

  if (!user || !user.isActive) {
    throw AppError.unauthorized("User not found or deactivated");
  }

  // Delete old token (rotation)
  await db
    .delete(refreshTokens)
    .where(eq(refreshTokens.id, storedToken.id));

  const tokens = await generateTokensForUser(user);

  return c.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
});

/**
 * POST /api/auth/logout - Invalidate refresh token
 */
auth.post("/logout", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { refreshToken: rt } = body as { refreshToken?: string };

  if (rt) {
    const tokenHash = await hashToken(rt);
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash));
  }

  const user = getUser(c);
  if (!rt) {
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, user.id));
  }

  return c.json({ message: "Logged out" });
});

// ──────────────────────────────────────────────────────
// Account deletion (Apple 5.1.1(v) / Google Play)
// ──────────────────────────────────────────────────────

/**
 * DELETE /api/auth/user/delete
 *
 * In-app deletion for the signed-in user. See `deleteUserAccount` for exactly what is
 * removed and what is retained.
 */
auth.delete("/user/delete", authMiddleware, async (c) => {
  await deleteUserAccount(getUser(c).id);
  return c.json({ success: true });
});

const ACCOUNT_DELETION_REQUEST_MESSAGE =
  "If an account exists for this email, we have sent a confirmation link.";

/**
 * POST /api/auth/account-deletion/request  { email, language? }
 *
 * Public (no login), so Google Play can point at a web page. Always answers 200 with the
 * same message, whether or not the email has an account, and whether or not an email
 * went out. Admin accounts get no link (they cannot be deleted this way).
 */
auth.post("/account-deletion/request", authIpLimiter(), authEmailLimiter(), async (c) => {
  const data = requestAccountDeletionSchema.parse(await c.req.json());
  const email = data.email.toLowerCase().trim();

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });

  if (user && user.role !== "admin" && user.role !== "superadmin") {
    const token = generateMagicLinkToken();
    const tokenHash = await hashToken(token);

    // One live link per address: a new request replaces the previous one.
    await db.delete(accountDeletionTokens).where(eq(accountDeletionTokens.email, email));
    await db.insert(accountDeletionTokens).values({
      email,
      tokenHash,
      expiresAt: magicLinkExpiresAt(),
    });

    const language = data.language ?? user.preferredLanguage;
    const confirmUrl = `${config.urls.frontend}/account-deletion?token=${token}`;
    try {
      await sendEmail({ to: email, ...buildAccountDeletionEmail(confirmUrl, language) });
    } catch (err) {
      // Swallowed on purpose: surfacing a failure would reveal that the account exists.
      console.error("[ACCOUNT DELETION] could not send confirmation email:", err);
    }
  }

  return c.json({ success: true, message: ACCOUNT_DELETION_REQUEST_MESSAGE });
});

/**
 * POST /api/auth/account-deletion/confirm  { token }
 *
 * Redeems the emailed link and runs the same deletion as the in-app route. Tokens are
 * single use: the service removes every deletion token for the address along with the
 * account, and a failed attempt (e.g. Easypay unreachable) leaves the token valid so the
 * person can retry until it expires.
 */
auth.post("/account-deletion/confirm", authIpLimiter(), async (c) => {
  const data = confirmAccountDeletionSchema.parse(await c.req.json());
  const tokenHash = await hashToken(data.token);

  const row = await db.query.accountDeletionTokens.findFirst({
    where: and(
      eq(accountDeletionTokens.tokenHash, tokenHash),
      gt(accountDeletionTokens.expiresAt, new Date()),
    ),
  });
  const user = row
    ? await db.query.users.findFirst({ where: eq(users.email, row.email) })
    : undefined;
  if (!row || !user) {
    throw AppError.badRequest("This link is invalid or has expired.", "INVALID_TOKEN");
  }

  await deleteUserAccount(user.id);
  return c.json({ success: true });
});

/**
 * GET /api/auth/me - Get current user profile (admin format)
 */
auth.get("/me", authMiddleware, async (c) => {
  const authUser = getUser(c);

  const user = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });

  if (!user) {
    throw AppError.notFound("User not found");
  }

  return c.json({
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    dharmaName: user.dharmaName,
    preferredLanguage: user.preferredLanguage,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
    subscription: subscriptionForApp(user),
  });
});

// ──────────────────────────────────────────────────────
// HTML rendering for activation page
// ──────────────────────────────────────────────────────

interface ActivationPage {
  lang: Lang;
  kind: "success" | "error" | "info" | "confirm";
  title: string;
  message: string;
  /** Only on the confirmation page: the form that activates the device. */
  confirm?: { action: string; button: string; note: string };
}

const ACTIVATION_PAGE_LOOK: Record<ActivationPage["kind"], { bg: string; iconColor: string; icon: string }> = {
  success: { bg: "#f0fdf4", iconColor: "#16a34a", icon: "&#10003;" },
  error: { bg: "#fef2f2", iconColor: "#dc2626", icon: "&#10007;" },
  info: { bg: "#f5f5f5", iconColor: "#666", icon: "i" },
  // No icon: the sentence and the button are the whole page.
  confirm: { bg: "#f0fdf4", iconColor: "#16a34a", icon: "" },
};

/** Every value is escaped: the device name and type come from the client. */
function renderActivationPage(page: ActivationPage): string {
  const look = ACTIVATION_PAGE_LOOK[page.kind];
  const iconHtml = look.icon ? `<div class="icon">${look.icon}</div>\n    ` : "";
  const confirmHtml = page.confirm
    ? `
    <form method="post" action="${escapeHtml(page.confirm.action)}">
      <button type="submit">${escapeHtml(page.confirm.button)}</button>
    </form>
    <p class="note">${escapeHtml(page.confirm.note)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="${page.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(page.title)} - Padmakara</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: ${look.bg};
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: ${look.iconColor};
      color: white;
      font-size: 32px;
      line-height: 64px;
      margin: 0 auto 20px;
    }
    h1 { font-size: 24px; color: #1a1a1a; margin-bottom: 12px; }
    p { font-size: 16px; color: #666; line-height: 1.5; }
    form { margin: 28px 0 20px; }
    button {
      width: 100%;
      min-height: 56px;
      padding: 16px 24px;
      border: none;
      border-radius: 12px;
      background: ${look.iconColor};
      color: white;
      font: inherit;
      font-size: 20px;
      font-weight: 600;
      cursor: pointer;
    }
    button:focus-visible { outline: 3px solid #1a1a1a; outline-offset: 3px; }
  </style>
</head>
<body>
  <div class="card">
    ${iconHtml}<h1>${escapeHtml(page.title)}</h1>
    <p>${escapeHtml(page.message)}</p>${confirmHtml}
  </div>
</body>
</html>`;
}

export { auth };
