import { Hono } from "hono";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users, userGroupMemberships } from "../db/schema/users.ts";
import {
  refreshTokens,
  magicLinkTokens,
  deviceActivations,
  userApprovalRequests,
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
import { sendEmail, buildMagicLinkEmail } from "../services/email.ts";
import { AppError } from "../lib/errors.ts";
import {
  loginSchema,
  requestMagicLinkSchema,
  verifyMagicLinkSchema,
  refreshTokenSchema,
  discoverDeviceSchema,
  requestApprovalSchema,
  autoActivateSchema,
  deactivateDeviceSchema,
} from "../lib/schemas.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { config } from "../config.ts";

const auth = new Hono();

/**
 * Format a user record for the mobile app's expected shape.
 * The app stores this as the User object in AsyncStorage.
 */
async function formatUserForApp(user: {
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
    subscription: {
      status: user.subscriptionStatus as "active" | "expired" | "none",
      source: user.subscriptionSource,
      expiresAt: user.subscriptionExpiresAt?.toISOString() || null,
    },
    created_at: user.createdAt.toISOString(),
    last_login: user.lastActivity?.toISOString() || user.createdAt.toISOString(),
  };
}

/**
 * Generate JWT tokens + store refresh token for a user.
 */
async function generateTokensForUser(user: { id: number; email: string; role: string }) {
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
auth.post("/login", async (c) => {
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
// Device-based magic link auth — used by React Native app
// ──────────────────────────────────────────────────────

/**
 * POST /api/auth/request-magic-link
 *
 * Step 1 of mobile auth. The app sends email + device info.
 * - If user exists & device already activated → return tokens immediately
 * - If user exists but device not activated → send magic link email
 * - If user doesn't exist → return "approval_required"
 */
auth.post("/request-magic-link", async (c) => {
  const body = await c.req.json();
  const data = requestMagicLinkSchema.parse(body);

  const email = data.email.toLowerCase().trim();

  // Look up user
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user) {
    return c.json({
      status: "approval_required",
      message: "Email not found. Please request access.",
      email,
    });
  }

  if (!user.isActive) {
    throw AppError.unauthorized("Account is deactivated");
  }

  // Check if this device is already activated for this user
  const existingDevice = await db.query.deviceActivations.findFirst({
    where: and(
      eq(deviceActivations.deviceFingerprint, data.device_fingerprint),
      eq(deviceActivations.userId, user.id),
      eq(deviceActivations.isActive, true),
    ),
  });

  if (existingDevice) {
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

  // Device not activated — create magic link and send email
  const token = generateMagicLinkToken();
  const tokenHash = await hashToken(token);

  await db.insert(magicLinkTokens).values({
    email,
    tokenHash,
    expiresAt: magicLinkExpiresAt(),
    deviceFingerprint: data.device_fingerprint,
    deviceName: data.device_name,
    deviceType: data.device_type,
    language: data.language ?? "en",
  });

  // Build activation URL (points to backend, which renders HTML)
  const magicLinkUrl = `${config.urls.backend}/api/auth/activate/${token}?lang=${data.language}`;
  const emailContent = buildMagicLinkEmail(magicLinkUrl, data.language ?? "en");

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
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  🔑 DEV: Click to activate device            ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`  ${magicLinkUrl}\n`);
  }

  return c.json(response);
});

/**
 * GET /api/auth/activate/:token
 *
 * Called when user clicks the magic link in their email (opens in browser).
 * Validates token, creates DeviceActivation, renders HTML success page.
 * The mobile app discovers this activation via the /device/discover endpoint.
 */
auth.get("/activate/:token", async (c) => {
  const token = c.req.param("token");
  const tokenHash = await hashToken(token);

  // Find valid, unused token
  const magicLink = await db.query.magicLinkTokens.findFirst({
    where: and(
      eq(magicLinkTokens.tokenHash, tokenHash),
      eq(magicLinkTokens.isUsed, false),
      gt(magicLinkTokens.expiresAt, new Date()),
    ),
  });

  // Use query param first, then token language, then default to English
  const lang = c.req.query("lang") || magicLink?.language || "en";

  if (!magicLink) {
    const title = lang === "pt" ? "Link Inválido" : "Invalid Link";
    const message = lang === "pt"
      ? "Este link é inválido ou já expirou. Por favor solicite um novo link na aplicação."
      : "This link is invalid or has expired. Please request a new link in the app.";
    return c.html(renderActivationPage(title, message, false));
  }

  // Mark token as used
  await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(eq(magicLinkTokens.id, magicLink.id));

  // Find the user
  const user = await db.query.users.findFirst({
    where: eq(users.email, magicLink.email),
  });

  if (!user || !user.isActive) {
    const title = lang === "pt" ? "Conta Não Encontrada" : "Account Not Found";
    const message = lang === "pt"
      ? "Não foi possível encontrar a sua conta. Por favor contacte o suporte."
      : "Your account could not be found. Please contact support.";
    return c.html(renderActivationPage(title, message, false));
  }

  // Mark user as verified
  if (!user.isVerified) {
    await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  // Create or reactivate device activation
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
      });
    }
  }

  // Update user last activity
  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  const title = lang === "pt" ? "Dispositivo Ativado" : "Device Activated";
  const message = lang === "pt"
    ? "O seu dispositivo foi ativado com sucesso! Pode voltar à aplicação."
    : "Your device has been activated successfully! You can return to the app.";
  return c.html(renderActivationPage(title, message, true));
});

/**
 * POST /api/auth/device/discover
 *
 * Polling endpoint. The mobile app calls this every few seconds after
 * requesting a magic link to check if the device was activated
 * (by the user clicking the link in their email).
 */
auth.post("/device/discover", async (c) => {
  const body = await c.req.json();
  const data = discoverDeviceSchema.parse(body);

  const device = await db.query.deviceActivations.findFirst({
    where: and(
      eq(deviceActivations.deviceFingerprint, data.device_fingerprint),
      eq(deviceActivations.isActive, true),
    ),
  });

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

  // Update last used
  await db
    .update(deviceActivations)
    .set({ lastUsed: new Date() })
    .where(eq(deviceActivations.id, device.id));

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
 * POST /api/auth/request-approval
 *
 * For new users who don't have an account yet.
 * Creates an approval request that admins can review.
 */
auth.post("/request-approval", async (c) => {
  const body = await c.req.json();
  const data = requestApprovalSchema.parse(body);

  // Check if there's already a pending request for this email
  const existingRequest = await db.query.userApprovalRequests.findFirst({
    where: and(
      eq(userApprovalRequests.email, data.email.toLowerCase().trim()),
      eq(userApprovalRequests.status, "pending"),
    ),
  });

  if (existingRequest) {
    return c.json({
      status: "already_pending",
      message: "An approval request is already pending for this email",
    });
  }

  await db.insert(userApprovalRequests).values({
    email: data.email.toLowerCase().trim(),
    firstName: data.first_name,
    lastName: data.last_name,
    message: data.message || null,
    deviceFingerprint: data.device_fingerprint,
    deviceName: data.device_name,
    deviceType: data.device_type,
    language: data.language ?? "en",
    ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  });

  return c.json({
    status: "approval_requested",
    message: "Thank you for your request. An administrator will review it shortly.",
  });
});

/**
 * POST /api/auth/auto-activate
 *
 * Auto-activate a device using a magic link token directly
 * (for deep link / in-app activation flow).
 */
auth.post("/auto-activate", async (c) => {
  const body = await c.req.json();
  const data = autoActivateSchema.parse(body);

  const tokenHash = await hashToken(data.token);

  const magicLink = await db.query.magicLinkTokens.findFirst({
    where: and(
      eq(magicLinkTokens.tokenHash, tokenHash),
      eq(magicLinkTokens.isUsed, false),
      gt(magicLinkTokens.expiresAt, new Date()),
    ),
  });

  if (!magicLink) {
    throw AppError.unauthorized("Invalid or expired token");
  }

  // Mark token as used
  await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(eq(magicLinkTokens.id, magicLink.id));

  // Find user
  const user = await db.query.users.findFirst({
    where: eq(users.email, magicLink.email),
  });

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Account not found or deactivated");
  }

  // Mark user as verified
  if (!user.isVerified) {
    await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  // Create or reactivate device
  const existingDevice = await db.query.deviceActivations.findFirst({
    where: eq(deviceActivations.deviceFingerprint, data.device_fingerprint),
  });

  if (existingDevice) {
    await db
      .update(deviceActivations)
      .set({
        isActive: true,
        userId: user.id,
        deviceName: data.device_name,
        deviceType: data.device_type,
        lastUsed: new Date(),
        ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
        userAgent: c.req.header("user-agent") || null,
      })
      .where(eq(deviceActivations.id, existingDevice.id));
  } else {
    await db.insert(deviceActivations).values({
      userId: user.id,
      deviceFingerprint: data.device_fingerprint,
      deviceName: data.device_name,
      deviceType: data.device_type,
      ipAddress: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
      userAgent: c.req.header("user-agent") || null,
    });
  }

  const tokens = await generateTokensForUser(user);

  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

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
      eq(deviceActivations.deviceFingerprint, data.device_fingerprint),
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
  });
});

/**
 * POST /api/auth/verify-magic-link - Legacy endpoint for direct token verification.
 * Kept for backward compatibility; prefer the activate + discover flow.
 */
auth.post("/verify-magic-link", async (c) => {
  const body = await c.req.json();
  const data = verifyMagicLinkSchema.parse(body);

  const tokenHash = await hashToken(data.token);

  const magicLink = await db.query.magicLinkTokens.findFirst({
    where: and(
      eq(magicLinkTokens.tokenHash, tokenHash),
      eq(magicLinkTokens.isUsed, false),
      gt(magicLinkTokens.expiresAt, new Date()),
    ),
  });

  if (!magicLink) {
    throw AppError.unauthorized("Invalid or expired magic link");
  }

  await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(eq(magicLinkTokens.id, magicLink.id));

  let user = await db.query.users.findFirst({
    where: eq(users.email, magicLink.email),
  });

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({
        email: magicLink.email,
        isVerified: true,
        preferredLanguage: magicLink.language || "en",
      })
      .returning();
    user = newUser!;
  } else if (!user.isVerified) {
    await db
      .update(users)
      .set({ isVerified: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    user = { ...user, isVerified: true };
  }

  if (!user.isActive) {
    throw AppError.unauthorized("Account is deactivated");
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
// HTML rendering for activation page
// ──────────────────────────────────────────────────────

function renderActivationPage(title: string, message: string, success: boolean): string {
  const bgColor = success ? "#f0fdf4" : "#fef2f2";
  const iconColor = success ? "#16a34a" : "#dc2626";
  const icon = success ? "&#10003;" : "&#10007;";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Padmakara</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: ${bgColor};
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
      background: ${iconColor};
      color: white;
      font-size: 32px;
      line-height: 64px;
      margin: 0 auto 20px;
    }
    h1 { font-size: 24px; color: #1a1a1a; margin-bottom: 12px; }
    p { font-size: 16px; color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export { auth };
