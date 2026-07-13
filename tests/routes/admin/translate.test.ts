/**
 * Tests for POST /api/admin/translate — the stateless EN<->PT translate
 * endpoint. The route validates the body and calls Anthropic; the DB mock
 * only needs to satisfy the auth middleware's user lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
    select: vi.fn(),
  },
}));

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { createAccessToken } from "../../../src/services/auth.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}
function anthropicResponse(jsonText: string) {
  return { content: [{ type: "text", text: jsonText }] };
}

describe("POST /api/admin/translate", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key-123" };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns translations keyed like the input items", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      anthropicResponse(JSON.stringify({ title: "Retiro de Primavera" })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "Spring Retreat" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ title: "Retiro de Primavera" });
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("strips markdown code fences around the JSON", async () => {
    const withFences = "```json\n" + JSON.stringify({ title: "Olá" }) + "\n```";
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse(withFences));
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "Hello" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ title: "Olá" });
  });

  it("returns 400 for an invalid direction", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "es-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for empty items", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: {} }),
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when the model output is not parseable JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse("Sorry, cannot."));
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
  });

  it("returns 500 when model output is valid JSON but not an object of strings", async () => {
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse(JSON.stringify({ title: 42 })));
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
  });

  it("returns 401 without a token", async () => {
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(403);
  });
});
