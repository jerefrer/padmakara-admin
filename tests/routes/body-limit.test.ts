import { describe, it, expect } from "vitest";
import { testRequest } from "../helpers.ts";

const MB = 1024 * 1024;

function post(path: string, bytes: number, headers: Record<string, string> = {}) {
  return testRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "x".repeat(bytes),
  });
}

describe("request body size limit", () => {
  it("should refuse a public request body over 1 MB with 413", async () => {
    const res = await post("/api/webhooks/read-along", 2 * MB, { "X-Webhook-Signature": "bad" });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("should let a small public request body through", async () => {
    const res = await post("/api/webhooks/read-along", 1024, { "X-Webhook-Signature": "bad" });

    expect(res.status).toBe(401);
  });

  it("should let a larger body reach the admin routes, which take image and CSV uploads", async () => {
    const res = await post("/api/admin/library/upload", 2 * MB);

    // Rejected for the missing token, not for the size.
    expect(res.status).toBe(401);
  });
});
