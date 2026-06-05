import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { config } from "../../src/config.ts";
import { testRequest } from "../helpers.ts";

// vi.mock factories are hoisted above imports, so use vi.hoisted for shared refs.
const {
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
  mockInsert,
  mockInsertValues,
  mockInsertOnConflict,
  mockFindFirst,
} = vi.hoisted(() => {
  // insert chain: insert().values().onConflictDoUpdate()
  const mockInsertOnConflict = vi.fn(() => Promise.resolve());
  const mockInsertValues = vi.fn(() => ({ onConflictDoUpdate: mockInsertOnConflict }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  // update chain: update().set().where()
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  // query.sessions.findFirst — typed broadly so mockResolvedValueOnce can take any shape
  const mockFindFirst = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));

  return {
    mockUpdate,
    mockUpdateSet,
    mockUpdateWhere,
    mockInsert,
    mockInsertValues,
    mockInsertOnConflict,
    mockFindFirst,
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: mockUpdate,
    insert: mockInsert,
    query: {
      sessions: { findFirst: mockFindFirst },
    },
  },
}));

vi.mock("../../src/services/bunny-captions.ts", () => ({
  addCaption: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/s3.ts", () => ({
  getObjectText: vi.fn().mockResolvedValue("WEBVTT\n\n"),
}));

function sign(rawBody: string): string {
  return createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");
}

async function postSubtitlesWebhook(
  body: Record<string, unknown>,
  signature?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["X-Webhook-Signature"] = signature;
  return testRequest("/api/webhooks/subtitles", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/subtitles — signature verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing signature with 401", async () => {
    const res = await postSubtitlesWebhook({ jobId: "x", sessionId: 1, status: "failed" });
    expect(res.status).toBe(401);
  });

  it("rejects a bad (wrong-length) signature with 401", async () => {
    const res = await postSubtitlesWebhook(
      { jobId: "x", sessionId: 1, status: "failed" },
      "nope",
    );
    expect(res.status).toBe(401);
  });

  it("rejects a same-length but incorrect signature with 401", async () => {
    const res = await postSubtitlesWebhook(
      { jobId: "x", sessionId: 1, status: "failed" },
      "0".repeat(64),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid completed payload and returns 200", async () => {
    const body = {
      jobId: "job-1",
      sessionId: 1,
      status: "completed",
      language: "en",
      label: "English",
      s3Key: "events/E/subtitles/1/en.vtt",
      summary: { cues: 3 },
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  it("accepts a valid failed payload and returns 200", async () => {
    const body = { jobId: "job-2", sessionId: 1, status: "failed", error: "OOM" };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));
    expect(res.status).toBe(200);
  });

  it("uploads VTT to Bunny when session has a bunnyVideoId", async () => {
    const { addCaption } = await import("../../src/services/bunny-captions.ts");
    const { getObjectText } = await import("../../src/services/s3.ts");
    const mockAddCaption = addCaption as ReturnType<typeof vi.fn>;
    const mockGetObjectText = getObjectText as ReturnType<typeof vi.fn>;

    mockFindFirst.mockResolvedValueOnce({ id: 1, bunnyVideoId: "vid-abc" });
    mockGetObjectText.mockResolvedValueOnce("WEBVTT\n\n00:00.000 --> 00:01.000\nHello");

    const body = {
      jobId: "job-3",
      sessionId: 1,
      status: "completed",
      language: "en",
      label: "English",
      s3Key: "events/E/subtitles/1/en.vtt",
      summary: { cues: 1 },
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));
    expect(res.status).toBe(200);
    expect(mockAddCaption).toHaveBeenCalledWith(
      "vid-abc",
      "en",
      "English",
      "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
    );
  });

  it("skips Bunny upload when session has no bunnyVideoId", async () => {
    const { addCaption } = await import("../../src/services/bunny-captions.ts");
    const mockAddCaption = addCaption as ReturnType<typeof vi.fn>;

    mockFindFirst.mockResolvedValueOnce({ id: 1, bunnyVideoId: null });

    const body = {
      jobId: "job-4",
      sessionId: 1,
      status: "completed",
      language: "pt",
      label: "Portuguese",
      s3Key: "events/E/subtitles/1/pt.vtt",
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));
    expect(res.status).toBe(200);
    expect(mockAddCaption).not.toHaveBeenCalled();
  });
});
