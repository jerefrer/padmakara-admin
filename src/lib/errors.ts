import type { Context } from "hono";
import { z } from "zod";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    /** Structured context a client can act on (sent as `details`). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, code?: string) {
    return new AppError(400, message, code);
  }

  static unauthorized(message = "Unauthorized") {
    return new AppError(401, message, "UNAUTHORIZED");
  }

  static forbidden(message = "Forbidden") {
    return new AppError(403, message, "FORBIDDEN");
  }

  static notFound(message = "Not found") {
    return new AppError(404, message, "NOT_FOUND");
  }

  static conflict(message: string) {
    return new AppError(409, message, "CONFLICT");
  }

  static internal(message = "Internal server error") {
    return new AppError(500, message, "INTERNAL_ERROR");
  }
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.details ? { details: err.details } : {}),
      },
      err.statusCode as any,
    );
  }

  if (err instanceof z.ZodError) {
    return c.json(
      {
        error: "Validation error",
        code: "VALIDATION_ERROR",
        issues: err.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
      400,
    );
  }

  // Handle Postgres unique constraint violations (code 23505). Postgres's `detail`
  // echoes the conflicting value (an email, a token hash), so it is never sent; the
  // constraint name is logged instead.
  const pgError = (err as any).cause ?? err;
  if (pgError?.code === "23505") {
    console.warn("Unique constraint violation:", pgError.constraint ?? pgError.constraint_name);
    return c.json(
      {
        error: "A record with this value already exists",
        code: "CONFLICT",
      },
      409,
    );
  }

  console.error("Unhandled error:", err);
  return c.json(
    {
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    },
    500,
  );
}
