/**
 * Auth middleware edge cases.
 *
 * A tiny isolated Hono app wires authMiddleware, optionalAuthMiddleware and
 * adminMiddleware in front of handlers that echo the resolved user, so each
 * test sees exactly what a real route would see. Tokens are signed with the
 * test JWT secret from tests/setup.ts (or a different one, on purpose).
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import * as jose from "jose";
import {
  authMiddleware,
  optionalAuthMiddleware,
  getUser,
  getOptionalUser,
} from "../../src/middleware/auth.ts";
import { adminMiddleware } from "../../src/middleware/admin.ts";
import { createAccessToken, createRefreshToken } from "../../src/services/auth.ts";
import { AppError, errorHandler } from "../../src/lib/errors.ts";
import { config } from "../../src/config.ts";

const SECRET = new TextEncoder().encode(config.jwt.secret);

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);

  app.get("/protected", authMiddleware, (c) => c.json({ user: getUser(c) }));
  app.get("/protected/missing", authMiddleware, () => {
    throw AppError.notFound("Thing not found");
  });
  app.get("/optional", optionalAuthMiddleware, (c) => c.json({ user: getOptionalUser(c) }));
  app.get("/no-middleware", (c) => c.json({ user: getUser(c) }));
  app.get("/admin", authMiddleware, adminMiddleware, (c) => c.json({ ok: true }));
  return app;
}

const app = buildApp();

async function call(path: string, authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.Authorization = authorization;
  const res = await app.request(path, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function accessToken(role = "user", sub = 7) {
  return createAccessToken({ sub, email: "seeker@test.com", role });
}

async function signWith(
  claims: jose.JWTPayload,
  opts: { secret?: Uint8Array; exp?: number | string; alg?: string } = {},
) {
  const jwt = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setSubject("7")
    .setIssuedAt();
  if (opts.exp !== undefined) jwt.setExpirationTime(opts.exp);
  return jwt.sign(opts.secret ?? SECRET);
}

/** An unsigned token ("alg": "none") carrying an admin role claim. */
function unsignedAdminToken() {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "7", email: "x@test.com", role: "admin" })}.`;
}

describe("authMiddleware", () => {
  it("should expose id, email and role from a valid access token", async () => {
    const { status, body } = await call("/protected", `Bearer ${await accessToken("user", 7)}`);

    expect(status).toBe(200);
    expect(body.user).toEqual({ id: 7, email: "seeker@test.com", role: "user" });
  });

  it("should return 401 when the Authorization header is missing", async () => {
    const { status, body } = await call("/protected");

    expect(status).toBe(401);
    expect(body).toEqual({ error: "Missing or invalid Authorization header", code: "UNAUTHORIZED" });
  });

  it("should return 401 for a non-Bearer scheme", async () => {
    const { status } = await call("/protected", `Basic ${Buffer.from("a:b").toString("base64")}`);

    expect(status).toBe(401);
  });

  it("should return 401 for a raw token sent without the Bearer prefix", async () => {
    const { status } = await call("/protected", await accessToken());

    expect(status).toBe(401);
  });

  it("should return 401 for an empty Bearer token", async () => {
    // Header values are trimmed, so "Bearer " arrives as "Bearer" and fails the prefix check.
    const { status } = await call("/protected", "Bearer ");

    expect(status).toBe(401);
  });

  it("should return 401 for a malformed token", async () => {
    const { status, body } = await call("/protected", "Bearer not.a.jwt");

    expect(status).toBe(401);
    expect(body.error).toBe("Invalid or expired token");
  });

  it("should return 401 for an expired token", async () => {
    const expired = await signWith(
      { email: "seeker@test.com", role: "user" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );

    const { status, body } = await call("/protected", `Bearer ${expired}`);

    expect(status).toBe(401);
    expect(body.error).toBe("Invalid or expired token");
  });

  it("should return 401 for a token signed with a different secret", async () => {
    const forged = await signWith(
      { email: "seeker@test.com", role: "admin" },
      { secret: new TextEncoder().encode("some-other-secret"), exp: "1h" },
    );

    const { status } = await call("/protected", `Bearer ${forged}`);

    expect(status).toBe(401);
  });

  it("should return 401 for an unsigned token (alg: none)", async () => {
    const { status } = await call("/protected", `Bearer ${unsignedAdminToken()}`);

    expect(status).toBe(401);
  });

  it("should return 401 when the payload was tampered with after signing", async () => {
    const [header, , signature] = (await accessToken("user")).split(".");
    const payload = Buffer.from(
      JSON.stringify({ sub: "7", email: "seeker@test.com", role: "admin" }),
    ).toString("base64url");

    const { status } = await call("/protected", `Bearer ${header}.${payload}.${signature}`);

    expect(status).toBe(401);
  });

  it("should let a downstream error keep its own status instead of becoming a 401", async () => {
    const { status, body } = await call("/protected/missing", `Bearer ${await accessToken()}`);

    expect(status).toBe(404);
    expect(body.error).toBe("Thing not found");
  });

  // BUG (reported in the PR, not fixed here): refresh and access tokens are
  // signed with the same secret and verifyToken never checks the token type,
  // so a refresh token (60-day lifetime, `type: "refresh"`, no email/role) is
  // accepted as a Bearer access token. Logging out deletes the refresh-token
  // row, but the middleware never consults it, so a leaked refresh token keeps
  // working as an access token until it expires. optionalAuthMiddleware has
  // the same gap.
  it.fails("should reject a refresh token used as an access token", async () => {
    const refresh = await createRefreshToken({ sub: 7, email: "seeker@test.com", role: "user" });

    const { status } = await call("/protected", `Bearer ${refresh}`);

    expect(status).toBe(401);
  });
});

describe("optionalAuthMiddleware", () => {
  it("should resolve the user from a valid token", async () => {
    const { status, body } = await call("/optional", `Bearer ${await accessToken("admin", 3)}`);

    expect(status).toBe(200);
    expect(body.user).toEqual({ id: 3, email: "seeker@test.com", role: "admin" });
  });

  it("should continue as anonymous without a header", async () => {
    const { status, body } = await call("/optional");

    expect(status).toBe(200);
    expect(body.user).toBeNull();
  });

  it("should continue as anonymous with an expired token", async () => {
    const expired = await signWith(
      { email: "seeker@test.com", role: "user" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );

    const { status, body } = await call("/optional", `Bearer ${expired}`);

    expect(status).toBe(200);
    expect(body.user).toBeNull();
  });

  it("should continue as anonymous with a forged token rather than trusting its claims", async () => {
    const { status, body } = await call("/optional", `Bearer ${unsignedAdminToken()}`);

    expect(status).toBe(200);
    expect(body.user).toBeNull();
  });

  it("should ignore a token passed in the query string", async () => {
    const token = await accessToken();

    const { body } = await call(`/optional?token=${token}`);

    expect(body.user).toBeNull();
  });
});

describe("getUser", () => {
  it("should throw 401 when no auth middleware has run", async () => {
    const { status } = await call("/no-middleware");

    expect(status).toBe(401);
  });
});

describe("adminMiddleware", () => {
  it.each(["admin", "superadmin"])("should let a %s through", async (role) => {
    const { status } = await call("/admin", `Bearer ${await accessToken(role)}`);

    expect(status).toBe(200);
  });

  it("should return 403 for a regular user", async () => {
    const { status, body } = await call("/admin", `Bearer ${await accessToken("user")}`);

    expect(status).toBe(403);
    expect(body.error).toBe("Admin access required");
  });

  it("should match roles exactly (no case folding)", async () => {
    const { status } = await call("/admin", `Bearer ${await accessToken("Admin")}`);

    expect(status).toBe(403);
  });

  it("should return 403 for a validly signed token that carries no role", async () => {
    const noRole = await signWith({ email: "seeker@test.com" }, { exp: "1h" });

    const { status } = await call("/admin", `Bearer ${noRole}`);

    expect(status).toBe(403);
  });

  it("should return 401 (not 403) when the token is invalid", async () => {
    const { status } = await call("/admin", "Bearer garbage");

    expect(status).toBe(401);
  });
});
