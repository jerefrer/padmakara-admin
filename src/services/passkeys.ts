import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { passkeyCredentials, webauthnChallenges } from "../db/schema/passkeys.ts";
import { AppError } from "../lib/errors.ts";

/** Challenges live five minutes and can be consumed once. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type PasskeySummary = {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type PasskeyRow = typeof passkeyCredentials.$inferSelect;

function toSummary(row: Pick<PasskeyRow, "id" | "name" | "createdAt" | "lastUsedAt">): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

async function storeChallenge(
  challenge: string,
  purpose: "register" | "login",
  userId: number | null,
): Promise<string> {
  // Keep the table bounded: drop challenges that expired over an hour ago.
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, sql`now() - interval '1 hour'`));
  const [row] = await db
    .insert(webauthnChallenges)
    .values({ challenge, purpose, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
    .returning({ id: webauthnChallenges.id });
  if (!row) throw AppError.internal("Could not store challenge");
  return row.id;
}

/**
 * Atomically marks a challenge used and returns it. The purpose (and, for
 * registration, the owner) must match, it must be unused and unexpired; a
 * replayed, expired or mismatched challenge matches no row and returns null.
 */
async function consumeChallenge(
  challengeId: string,
  purpose: "register" | "login",
  userId?: number,
): Promise<{ challenge: string } | null> {
  const conditions = [
    eq(webauthnChallenges.id, challengeId),
    eq(webauthnChallenges.purpose, purpose),
    eq(webauthnChallenges.used, false),
    gt(webauthnChallenges.expiresAt, sql`now()`),
  ];
  if (userId !== undefined) conditions.push(eq(webauthnChallenges.userId, userId));
  const [row] = await db
    .update(webauthnChallenges)
    .set({ used: true })
    .where(and(...conditions))
    .returning({ challenge: webauthnChallenges.challenge });
  return row ?? null;
}

export async function createRegistrationOptions(user: {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const existing = await db
    .select({ credentialId: passkeyCredentials.credentialId, transports: passkeyCredentials.transports })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, user.id));
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.email,
    userDisplayName: fullName || user.email,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = await storeChallenge(options.challenge, "register", user.id);
  return { challengeId, options };
}

export async function verifyRegistration(
  userId: number,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeySummary> {
  const challenge = await consumeChallenge(challengeId, "register", userId);
  if (!challenge) throw AppError.badRequest("Invalid or expired challenge", "INVALID_CHALLENGE");

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...config.webauthn.origins],
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw AppError.badRequest("Passkey registration could not be verified", "PASSKEY_VERIFICATION_FAILED");
  }
  if (!verification.verified) {
    throw AppError.badRequest("Passkey registration could not be verified", "PASSKEY_VERIFICATION_FAILED");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const [row] = await db
    .insert(passkeyCredentials)
    .values({
      userId,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name,
    })
    .returning();
  if (!row) throw AppError.internal("Could not store passkey");
  return toSummary(row);
}

export async function createLoginOptions(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    userVerification: "required",
  });
  const challengeId = await storeChallenge(options.challenge, "login", null);
  return { challengeId, options };
}

/** Returns the user id the key belongs to. Every failure is the same 401. */
export async function verifyLogin(challengeId: string, response: AuthenticationResponseJSON): Promise<number> {
  const fail = () => AppError.unauthorized("Passkey sign-in failed");
  try {
    const challenge = await consumeChallenge(challengeId, "login");
    if (!challenge) throw fail();

    const [stored] = await db
      .select()
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.credentialId, response.id))
      .limit(1);
    if (!stored) throw fail();

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...config.webauthn.origins],
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports ?? undefined,
      },
    });
    if (!verification.verified) throw fail();

    await db
      .update(passkeyCredentials)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeyCredentials.id, stored.id));
    return stored.userId;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 401) throw err;
    throw fail();
  }
}

export async function listPasskeys(userId: number): Promise<PasskeySummary[]> {
  const rows = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, userId))
    .orderBy(passkeyCredentials.createdAt);
  return rows.map(toSummary);
}

/** Deletes one of the user's own keys; false when it does not exist or belongs to someone else. */
export async function deletePasskey(userId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(passkeyCredentials)
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, userId)))
    .returning({ id: passkeyCredentials.id });
  return rows.length > 0;
}
