import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { config } from "../../src/config.ts";
import { testRequest } from "../helpers.ts";

// The read-along handler updates the readAlongJobs row after a valid signature.
// Mock the db so the valid-signature test does not need a real database.
vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  },
}));

function sign(rawBody: string): string {
  return createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");
}

async function postReadAlong(
  body: Record<string, unknown>,
  signature?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["X-Webhook-Signature"] = signature;
  return testRequest("/api/webhooks/read-along", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/read-along — signature verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the signature header is missing", async () => {
    const res = await postReadAlong({ jobId: "j1", status: "failed" });
    expect(res.status).toBe(401);
  });

  it("returns 401 (not 500) for a short, wrong-length signature", async () => {
    // Pre-fix this crashes: timingSafeEqual throws RangeError on length mismatch.
    const res = await postReadAlong({ jobId: "j1", status: "failed" }, "x");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a same-length but incorrect signature", async () => {
    // "0".repeat(64) = valid length (a SHA-256 hex digest is 64 chars), wrong value
    const res = await postReadAlong({ jobId: "j1", status: "failed" }, "0".repeat(64));
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature and returns 200", async () => {
    const body = { jobId: "j1", status: "failed" };
    const res = await postReadAlong(body, sign(JSON.stringify(body)));
    expect(res.status).toBe(200);
  });
});
