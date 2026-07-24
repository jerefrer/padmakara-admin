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

  it("recovers a single-field translation when the model renames the key", async () => {
    // The per-field translate button sends the opaque key `v`. The model
    // occasionally keys its reply differently (e.g. echoing the prompt's
    // "title" example). For a one-field request the sole returned string is
    // unambiguously the translation, so the route maps it back to `v` instead
    // of dropping it — dropping it wiped the target field and forced a retry.
    mockMessagesCreate.mockResolvedValueOnce(
      anthropicResponse(JSON.stringify({ translation: "Retiro de Primavera" })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { v: "Spring Retreat" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ v: "Retiro de Primavera" });
  });

  it("does not guess a translation when a multi-field batch renames keys", async () => {
    // With more than one field a mismatched key is ambiguous — dropping it
    // (the client then leaves the field untouched) is safer than assigning the
    // wrong language to the wrong field.
    mockMessagesCreate.mockResolvedValueOnce(
      anthropicResponse(JSON.stringify({ wrong1: "A", wrong2: "B" })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { a: "x", b: "y" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({});
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

describe("POST /api/admin/translate — batching", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key-123" };
    // Echo each field key back with a "PT " prefix, so every batch returns
    // exactly the keys it was handed. Keys are the "### key" headers in the
    // user prompt.
    mockMessagesCreate.mockImplementation(({ messages }: any) => {
      // Capture group 1 always exists when the pattern matches.
      const keys = [...String(messages[0].content).matchAll(/^### (.+)$/gm)].map((m) => m[1]!);
      const obj: Record<string, string> = {};
      for (const k of keys) obj[k] = `PT ${k}`;
      return Promise.resolve(anthropicResponse(JSON.stringify(obj)));
    });
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("splits a 363-title bulk translate across calls and returns every key", async () => {
    const items: Record<string, string> = {};
    for (let i = 0; i < 363; i++) items[`track:t${i}`] = `Title ${i}`;

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items }),
    });

    expect(status).toBe(200);
    const translations = (body as any).translations as Record<string, string>;
    // Every requested key comes back, none dropped or duplicated.
    expect(Object.keys(translations)).toHaveLength(363);
    expect(translations["track:t0"]).toBe("PT track:t0");
    expect(translations["track:t362"]).toBe("PT track:t362");
    // 363 short fields → ceil(363 / 40) = 10 batches (field-count cap).
    expect(mockMessagesCreate).toHaveBeenCalledTimes(10);
  });

  it("makes a single call when the field count fits one batch", async () => {
    const items: Record<string, string> = {};
    for (let i = 0; i < 40; i++) items[`track:t${i}`] = `Title ${i}`;

    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items }),
    });

    expect(status).toBe(200);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("puts a single oversized field in its own batch", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        direction: "en-to-pt",
        // One 6000-char field (> BATCH_MAX_CHARS) alongside a short one → the
        // big field closes its own batch, the short one lands in the next.
        items: { big: "x".repeat(6000), small: "hi" },
      }),
    });

    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ big: "PT big", small: "PT small" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("fails the whole request if one batch cannot be parsed", async () => {
    // First batch parses; second returns junk → the route surfaces a 500
    // rather than silently returning a partial translation.
    mockMessagesCreate.mockReset();
    let call = 0;
    mockMessagesCreate.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1 ? anthropicResponse(JSON.stringify({ "track:t0": "ok" })) : anthropicResponse("not json"),
      );
    });
    const items: Record<string, string> = {};
    for (let i = 0; i < 60; i++) items[`track:t${i}`] = `Title ${i}`;

    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items }),
    });
    expect(status).toBe(500);
  });
});
