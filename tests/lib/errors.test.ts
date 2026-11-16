import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { AppError, errorHandler } from "../../src/lib/errors.ts";

describe("errorHandler on a unique-constraint violation", () => {
  it("should answer 409 without the Postgres detail, which echoes the conflicting value", async () => {
    const app = new Hono();
    app.get("/", () => {
      throw Object.assign(new Error("duplicate key"), {
        code: "23505",
        detail: "Key (email)=(someone@example.com) already exists.",
      });
    });
    app.onError(errorHandler);

    const res = await app.request("/");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "A record with this value already exists", code: "CONFLICT" });
  });
});

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
