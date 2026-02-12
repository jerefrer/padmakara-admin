import * as jose from "jose";
import bcrypt from "bcryptjs";
import { config } from "../config.ts";

const JWT_SECRET = new TextEncoder().encode(config.jwt.secret);

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid expiry format: ${expiry}`);
  const [, num, unit] = match;
  const value = parseInt(num!, 10);
  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface TokenPayload {
  sub: number;
  email: string;
  role: string;
}

export async function createAccessToken(payload: TokenPayload): Promise<string> {
  return await new jose.SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(payload.sub))
    .setIssuedAt()
    .setExpirationTime(config.jwt.accessTokenExpiry)
    .sign(JWT_SECRET);
}

export async function createRefreshToken(payload: TokenPayload): Promise<string> {
  return await new jose.SignJWT({ type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(payload.sub))
    .setIssuedAt()
    .setExpirationTime(config.jwt.refreshTokenExpiry)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<jose.JWTPayload & { email?: string; role?: string }> {
  const { payload } = await jose.jwtVerify(token, JWT_SECRET);
  return payload as jose.JWTPayload & { email?: string; role?: string };
}

export function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function magicLinkExpiresAt(): Date {
  return new Date(Date.now() + 60 * 60 * 1000); // 1 hour
}

export function refreshTokenExpiresAt(): Date {
  const seconds = parseExpiry(config.jwt.refreshTokenExpiry);
  return new Date(Date.now() + seconds * 1000);
}
