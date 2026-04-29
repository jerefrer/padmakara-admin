/**
 * Media Access Token (MAT) — short-lived signed token granting playback
 * access to a single session's video for a single user.
 *
 * Flow:
 *   1. Client calls /api/media/video/session/:id with their auth JWT.
 *   2. Backend verifies audience access, then issues a MAT scoped to:
 *        - userId (sub)
 *        - sessionId (sid)
 *        - bunnyVideoId (gid) — locks the token to one Bunny video
 *        - expiry (exp) — typically 4h
 *   3. Client appends ?mat=<token> to every HLS-proxy request.
 *   4. The proxy verifies the MAT cryptographically on each segment, sub-
 *      playlist, and master fetch — no DB hit needed past issuance.
 *
 * Security notes:
 *   - MATs are HS256-signed with the same JWT secret used for auth tokens.
 *     A leaked MAT is far less dangerous than a leaked auth JWT: it only
 *     plays one video, and only until exp.
 *   - Audience access is checked once at issuance. If the user loses access
 *     mid-playback, their existing MAT keeps working until expiry. That's
 *     acceptable — the alternative is a per-segment DB lookup, which would
 *     hammer Postgres on every ~10s of playback.
 *   - 4h expiry covers our longest video (~3h) plus headroom for pauses.
 */
import * as jose from "jose";
import { config } from "../config.ts";

const SECRET = new TextEncoder().encode(config.jwt.secret);
const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

export interface MatPayload {
  /** User id at issuance time. Stored for audit; the proxy doesn't re-check group membership. */
  sub: number;
  /** Session id this token unlocks. The proxy rejects requests for any other sessionId. */
  sid: number;
  /** Bunny video GUID locked at issuance — independent of any later session edits. */
  gid: string;
  /** Issued-at unix epoch seconds. */
  iat: number;
  /** Expiry unix epoch seconds. */
  exp: number;
}

export async function issueMat(args: {
  userId: number;
  sessionId: number;
  bunnyVideoId: string;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: number }> {
  const ttl = args.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = await new jose.SignJWT({
    sub: String(args.userId),
    sid: args.sessionId,
    gid: args.bunnyVideoId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(SECRET);
  return { token, expiresAt };
}

export async function verifyMat(token: string): Promise<MatPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    if (
      typeof payload.sid !== "number" ||
      typeof payload.gid !== "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      sub: parseInt(payload.sub, 10),
      sid: payload.sid,
      gid: payload.gid,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    // Expired, malformed, or wrong signature.
    return null;
  }
}
