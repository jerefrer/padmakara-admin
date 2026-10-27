import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { config } from "../../src/config.ts";
import {
  safeEqual,
  verifyReviewCode,
  isReviewAccountEmail,
  isReviewLoginFor,
} from "../../src/services/review-account.ts";

const review = config.review as { email: string; code: string };
const original = { ...review };

afterEach(() => {
  review.email = original.email;
  review.code = original.code;
});

describe("safeEqual", () => {
  it("should return true when strings are identical", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });

  it("should return false when strings differ", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("should return false without throwing when lengths differ", () => {
    expect(safeEqual("short", "a much longer string")).toBe(false);
  });

  it("should compare with crypto.timingSafeEqual rather than ===", () => {
    const src = readFileSync(
      new URL("../../src/services/review-account.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("timingSafeEqual(");
  });
});

describe("review account config", () => {
  it("should disable code login when no code is configured", () => {
    review.email = "review@padmakara.pt";
    review.code = "";
    expect(isReviewLoginFor("review@padmakara.pt")).toBe(false);
    expect(verifyReviewCode("anything")).toBe(false);
    expect(verifyReviewCode("")).toBe(false);
  });

  it("should still recognise the review email when disabled", () => {
    review.code = "";
    expect(isReviewAccountEmail(" Review@Padmakara.pt ")).toBe(true);
  });

  it("should accept only the configured code when enabled", () => {
    review.code = "demo-code-1";
    expect(verifyReviewCode("demo-code-1")).toBe(true);
    expect(verifyReviewCode("demo-code-2")).toBe(false);
    expect(isReviewLoginFor("REVIEW@padmakara.pt")).toBe(true);
    expect(isReviewLoginFor("other@padmakara.pt")).toBe(false);
  });
});
