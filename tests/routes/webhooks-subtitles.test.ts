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
  mockFindFirstSubtitleJob,
  mockFindFirstSessionVideo,
  mockFindFirstSession,
  mockFindFirstEvent,
} = vi.hoisted(() => {
  // insert chain: insert().values().onConflictDoUpdate()
  const mockInsertOnConflict = vi.fn(() => Promise.resolve());
  const mockInsertValues = vi.fn(() => ({ onConflictDoUpdate: mockInsertOnConflict }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  // update chain: update().set().where()
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  // query.* findFirst — typed broadly so mockResolvedValueOnce can take any shape
  const mockFindFirstSubtitleJob = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
  const mockFindFirstSessionVideo = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
  const mockFindFirstSession = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
  const mockFindFirstEvent = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));

  return {
    mockUpdate,
    mockUpdateSet,
    mockUpdateWhere,
    mockInsert,
    mockInsertValues,
    mockInsertOnConflict,
    mockFindFirstSubtitleJob,
    mockFindFirstSessionVideo,
    mockFindFirstSession,
    mockFindFirstEvent,
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: mockUpdate,
    insert: mockInsert,
    query: {
      subtitleJobs: { findFirst: mockFindFirstSubtitleJob },
      sessionVideos: { findFirst: mockFindFirstSessionVideo },
      sessions: { findFirst: mockFindFirstSession },
      events: { findFirst: mockFindFirstEvent },
    },
  },
}));

vi.mock("../../src/services/bunny-captions.ts", () => ({
  addCaption: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/s3.ts", () => ({
  getObjectText: vi.fn().mockResolvedValue("WEBVTT\n\n"),
  putObject: vi.fn().mockResolvedValue(undefined),
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
    const res = await postSubtitlesWebhook({ jobId: "x", status: "failed" });
    expect(res.status).toBe(401);
  });

  it("rejects a bad (wrong-length) signature with 401", async () => {
    const res = await postSubtitlesWebhook({ jobId: "x", status: "failed" }, "nope");
    expect(res.status).toBe(401);
  });

  it("rejects a same-length but incorrect signature with 401", async () => {
    const res = await postSubtitlesWebhook(
      { jobId: "x", status: "failed" },
      "0".repeat(64),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid failed payload and returns 200", async () => {
    const body = { jobId: "job-2", status: "failed", error: "OOM" };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/webhooks/subtitles — session_video re-homing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attributes via the job row (not the payload), re-homes the VTT, and uploads to Bunny", async () => {
    const { addCaption } = await import("../../src/services/bunny-captions.ts");
    const { getObjectText, putObject } = await import("../../src/services/s3.ts");
    const mockAddCaption = addCaption as ReturnType<typeof vi.fn>;
    const mockGetObjectText = getObjectText as ReturnType<typeof vi.fn>;
    const mockPutObject = putObject as ReturnType<typeof vi.fn>;

    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-1",
      sessionId: 1,
      sessionVideoId: 5,
    });
    mockFindFirstSessionVideo.mockResolvedValueOnce({
      id: 5,
      sessionId: 1,
      bunnyVideoId: "vid-abc",
      position: 0,
    });
    mockFindFirstSession.mockResolvedValueOnce({ id: 1, eventId: 1, sessionNumber: 2 });
    mockFindFirstEvent.mockResolvedValueOnce({ id: 1, eventCode: "E1" });
    mockGetObjectText.mockResolvedValueOnce("WEBVTT\n\n00:00.000 --> 00:01.000\nHello");

    const body = {
      jobId: "job-1",
      // Stale/absent sessionId in the payload must be ignored — attribution
      // comes from the job row.
      status: "completed",
      language: "en",
      label: "English",
      s3Key: "scratch/job-1/en.vtt",
      summary: { cues: 1 },
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));

    expect(res.status).toBe(200);
    expect(mockGetObjectText).toHaveBeenCalledWith("scratch/job-1/en.vtt");
    expect(mockPutObject).toHaveBeenCalledWith(
      "events/E1/subtitles/s2/v5/en.vtt",
      expect.anything(),
      "text/vtt",
    );
    expect(mockAddCaption).toHaveBeenCalledWith(
      "vid-abc",
      "en",
      "English",
      "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
    );
  });

  it("skips re-homing when the job has no session_video attribution", async () => {
    const { addCaption } = await import("../../src/services/bunny-captions.ts");
    const { putObject } = await import("../../src/services/s3.ts");
    const mockAddCaption = addCaption as ReturnType<typeof vi.fn>;
    const mockPutObject = putObject as ReturnType<typeof vi.fn>;

    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-4",
      sessionId: 1,
      sessionVideoId: null,
    });

    const body = {
      jobId: "job-4",
      status: "completed",
      language: "pt",
      label: "Portuguese",
      s3Key: "scratch/job-4/pt.vtt",
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));

    expect(res.status).toBe(200);
    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockAddCaption).not.toHaveBeenCalled();
  });

  it("skips Bunny upload but still re-homes when the session_video has no bunnyVideoId", async () => {
    const { addCaption } = await import("../../src/services/bunny-captions.ts");
    const { putObject } = await import("../../src/services/s3.ts");
    const mockAddCaption = addCaption as ReturnType<typeof vi.fn>;
    const mockPutObject = putObject as ReturnType<typeof vi.fn>;

    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-5",
      sessionId: 1,
      sessionVideoId: 6,
    });
    mockFindFirstSessionVideo.mockResolvedValueOnce({
      id: 6,
      sessionId: 1,
      bunnyVideoId: "",
      position: 1,
    });
    mockFindFirstSession.mockResolvedValueOnce({ id: 1, eventId: 1, sessionNumber: 2 });
    mockFindFirstEvent.mockResolvedValueOnce({ id: 1, eventCode: "E1" });

    const body = {
      jobId: "job-5",
      status: "completed",
      language: "en",
      label: "English",
      s3Key: "scratch/job-5/en.vtt",
    };
    const rawBody = JSON.stringify(body);
    const res = await postSubtitlesWebhook(body, sign(rawBody));

    expect(res.status).toBe(200);
    expect(mockPutObject).toHaveBeenCalled();
    expect(mockAddCaption).not.toHaveBeenCalled();
  });
});
