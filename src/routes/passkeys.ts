import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { AppError } from "../lib/errors.ts";
import { passkeyLoginVerifySchema, passkeyRegisterVerifySchema } from "../lib/schemas.ts";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { authIpLimiter } from "../middleware/rate-limit.ts";
import { activateDeviceForUser } from "../services/device-activation.ts";
import {
  createLoginOptions,
  createRegistrationOptions,
  deletePasskey,
  listPasskeys,
  verifyLogin,
  verifyRegistration,
} from "../services/passkeys.ts";
import { formatUserForApp, generateTokensForUser } from "./auth.ts";

const passkeyRoutes = new Hono();

const DEFAULT_PASSKEY_NAME = "Passkey";

/** POST /register/options — signed-in user starts adding a passkey. */
passkeyRoutes.post("/register/options", authMiddleware, async (c) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, getUser(c).id) });
  if (!user || !user.isActive) throw AppError.unauthorized("Invalid or expired token");
  return c.json(await createRegistrationOptions(user));
});

/** POST /register/verify — stores the new passkey. */
passkeyRoutes.post("/register/verify", authMiddleware, async (c) => {
  const data = passkeyRegisterVerifySchema.parse(await c.req.json());
  const passkey = await verifyRegistration(
    getUser(c).id,
    data.challengeId,
    data.response as unknown as RegistrationResponseJSON,
    data.name ?? DEFAULT_PASSKEY_NAME,
  );
  return c.json({ passkey });
});

/** POST /login/options — public; discoverable-credential login, no email needed. */
passkeyRoutes.post("/login/options", authIpLimiter(), async (c) => {
  return c.json(await createLoginOptions());
});

/**
 * POST /login/verify — public. Same success shape as /review-login. Every failure
 * (bad or replayed challenge, unknown key, inactive or deleted user) is the same
 * generic 401 so nothing about the account leaks.
 */
passkeyRoutes.post("/login/verify", authIpLimiter(), async (c) => {
  const data = passkeyLoginVerifySchema.parse(await c.req.json());

  const userId = await verifyLogin(data.challengeId, data.response as unknown as AuthenticationResponseJSON);
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.isActive) throw AppError.unauthorized("Passkey sign-in failed");

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

/** GET / — the caller's passkeys. */
passkeyRoutes.get("/", authMiddleware, async (c) => {
  return c.json({ passkeys: await listPasskeys(getUser(c).id) });
});

/** DELETE /:id — 204, or 404 for a missing key or someone else's (indistinguishable). */
passkeyRoutes.delete("/:id", authMiddleware, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw AppError.notFound("Passkey not found");
  const deleted = await deletePasskey(getUser(c).id, id);
  if (!deleted) throw AppError.notFound("Passkey not found");
  return c.body(null, 204);
});

export { passkeyRoutes };
