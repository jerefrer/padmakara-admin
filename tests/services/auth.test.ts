import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  generateMagicLinkToken,
  hashToken,
} from "../../src/services/auth.ts";

describe("Password hashing", () => {
  it("hashes and verifies a password", async () => {
    const password = "test-password-123";
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("generates different hashes for the same password", async () => {
    const password = "test-password-123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    expect(hash1).not.toBe(hash2);
  });
});

describe("JWT tokens", () => {
  const testPayload = { sub: 1, email: "test@example.com", role: "user" };

  it("creates and verifies an access token", async () => {
    const token = await createAccessToken(testPayload);
    const payload = await verifyToken(token);

    expect(payload.sub).toBe("1");
    expect(payload.email).toBe("test@example.com");
    expect(payload.role).toBe("user");
    expect(payload.exp).toBeDefined();
  });

  it("creates and verifies a refresh token", async () => {
    const token = await createRefreshToken(testPayload);
    const payload = await verifyToken(token);

    expect(payload.sub).toBe("1");
    expect(payload.exp).toBeDefined();
  });

  it("rejects an invalid token", async () => {
    await expect(verifyToken("invalid-token")).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const token = await createAccessToken(testPayload);
    const tampered = token.slice(0, -5) + "XXXXX";
    await expect(verifyToken(tampered)).rejects.toThrow();
  });
});

describe("Magic link tokens", () => {
  it("generates a 64-character hex token", () => {
    const token = generateMagicLinkToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("generates unique tokens", () => {
    const token1 = generateMagicLinkToken();
    const token2 = generateMagicLinkToken();
    expect(token1).not.toBe(token2);
  });

  it("hashes a token to a consistent SHA-256 hex", async () => {
    const token = "test-token";
    const hash1 = await hashToken(token);
    const hash2 = await hashToken(token);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("produces different hashes for different tokens", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });
});
