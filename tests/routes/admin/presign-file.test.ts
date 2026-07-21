import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/services/s3.ts", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/s3.ts")>()),
  generatePresignedUploadUrl: vi.fn(() => Promise.resolve("https://s3/put-url")),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("POST /api/admin/upload/presign-file", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a deterministic s3Key + uploadUrl", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        eventCode: "EVT-01",
        filename: "notes.pdf",
        contentType: "application/pdf",
        fileType: "document",
      }),
    });
    expect(status).toBe(200);
    expect(body.s3Key).toBe("events/EVT-01/document/notes.pdf");
    expect(body.uploadUrl).toBe("https://s3/put-url");
  });

  it("returns 400 on invalid body", async () => {
    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventCode: "EVT-01" }),
    });
    expect(status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const { status } = await testJson("/api/admin/upload/presign-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventCode: "E", filename: "a.pdf", contentType: "application/pdf", fileType: "document" }),
    });
    expect(status).toBe(401);
  });
});
