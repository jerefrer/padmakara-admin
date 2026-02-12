import { Hono } from "hono";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { refreshTokens, magicLinkTokens } from "../db/schema/auth.ts";
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
} from "../lib/schemas.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { config } from "../config.ts";

const auth = new Hono();

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

  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };

  const [accessToken, refreshTokenValue] = await Promise.all([
    createAccessToken(payload),
    createRefreshToken(payload),
  ]);

  // Store hashed refresh token
  const tokenHash = await hashToken(refreshTokenValue);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: refreshTokenExpiresAt(),
  });

  // Update last activity
  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
});

/**
 * POST /api/auth/request-magic-link - Request magic link for mobile app login
 */
auth.post("/request-magic-link", async (c) => {
  const body = await c.req.json();
  const data = requestMagicLinkSchema.parse(body);

  // Generate token and store hash
  const token = generateMagicLinkToken();
  const tokenHash = await hashToken(token);

  await db.insert(magicLinkTokens).values({
    email: data.email,
    tokenHash,
    expiresAt: magicLinkExpiresAt(),
  });

  // Build magic link URL
  const magicLinkUrl = `${config.urls.frontend}/auth/magic-link?token=${token}`;
  const emailContent = buildMagicLinkEmail(magicLinkUrl, data.language ?? "en");

  await sendEmail({
    to: data.email,
    ...emailContent,
  });

  return c.json({ message: "Magic link sent" });
});

/**
 * POST /api/auth/verify-magic-link - Verify magic link token, create user if new
 */
auth.post("/verify-magic-link", async (c) => {
  const body = await c.req.json();
  const data = verifyMagicLinkSchema.parse(body);

  const tokenHash = await hashToken(data.token);

  // Find valid, unused token
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

  // Mark token as used
  await db
    .update(magicLinkTokens)
    .set({ isUsed: true })
    .where(eq(magicLinkTokens.id, magicLink.id));

  // Find or create user
  let user = await db.query.users.findFirst({
    where: eq(users.email, magicLink.email),
  });

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({
        email: magicLink.email,
        isVerified: true,
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

  // Update last activity
  await db
    .update(users)
    .set({ lastActivity: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json({
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
});

/**
 * POST /api/auth/refresh - Exchange refresh token for new access token
 */
auth.post("/refresh", async (c) => {
  const body = await c.req.json();
  const data = refreshTokenSchema.parse(body);

  // Verify the JWT structure of the refresh token
  let jwtPayload;
  try {
    jwtPayload = await verifyToken(data.refreshToken);
  } catch {
    throw AppError.unauthorized("Invalid refresh token");
  }

  const tokenHash = await hashToken(data.refreshToken);

  // Find valid stored token
  const storedToken = await db.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.tokenHash, tokenHash),
      gt(refreshTokens.expiresAt, new Date()),
    ),
  });

  if (!storedToken) {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  // Get the user
  const user = await db.query.users.findFirst({
    where: eq(users.id, storedToken.userId),
  });

  if (!user || !user.isActive) {
    throw AppError.unauthorized("User not found or deactivated");
  }

  // Delete the old refresh token (rotation)
  await db
    .delete(refreshTokens)
    .where(eq(refreshTokens.id, storedToken.id));

  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };

  const [accessToken, newRefreshToken] = await Promise.all([
    createAccessToken(payload),
    createRefreshToken(payload),
  ]);

  // Store new refresh token
  const newTokenHash = await hashToken(newRefreshToken);
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: newTokenHash,
    expiresAt: refreshTokenExpiresAt(),
  });

  return c.json({
    accessToken,
    refreshToken: newRefreshToken,
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

  // Optionally delete all refresh tokens for this user
  const user = getUser(c);
  if (!rt) {
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, user.id));
  }

  return c.json({ message: "Logged out" });
});

/**
 * GET /api/auth/me - Get current user profile
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

export { auth };
