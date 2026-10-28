import { describe, it, expect } from "vitest";
import {
  generateSignInCode,
  hashSignInCode,
  verifySignInCode,
  MAX_CODE_ATTEMPTS,
} from "../../src/services/sign-in-code.ts";

describe("sign-in code", () => {
  it("should generate exactly six decimal digits", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSignInCode()).toMatch(/^\d{6}$/);
    }
  });

  it("should hash deterministically and never contain the code", () => {
    const h = hashSignInCode("012345");
    expect(h).toBe(hashSignInCode("012345"));
    expect(h).not.toContain("012345");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should not match a plain sha256 of the code", async () => {
    const { createHash } = await import("node:crypto");
    const plain = createHash("sha256").update("012345").digest("hex");
    expect(hashSignInCode("012345")).not.toBe(plain);
  });

  it("should verify the right code and reject others", () => {
    const h = hashSignInCode("123456");
    expect(verifySignInCode("123456", h)).toBe(true);
    expect(verifySignInCode("123457", h)).toBe(false);
  });

  it("should return false for a malformed stored hash instead of throwing", () => {
    expect(verifySignInCode("123456", "not-hex")).toBe(false);
    expect(verifySignInCode("123456", "")).toBe(false);
  });

  it("should allow five attempts per token", () => {
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });
});
