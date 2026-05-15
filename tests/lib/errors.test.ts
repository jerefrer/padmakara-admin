import { describe, it, expect } from "vitest";
import { AppError } from "../../src/lib/errors.ts";

describe("AppError.internal", () => {
  it("exists as a static factory method", () => {
    expect(typeof AppError.internal).toBe("function");
  });

  it("creates a 500 AppError with the INTERNAL_ERROR code and default message", () => {
    const err = AppError.internal();
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("Internal server error");
  });

  it("accepts a custom message", () => {
    const err = AppError.internal("S3 fetch failed");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("S3 fetch failed");
  });
});
