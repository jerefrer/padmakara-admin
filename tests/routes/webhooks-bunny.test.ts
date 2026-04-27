import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { testRequest } from "../helpers.ts";

// vi.mock factories are hoisted above the imports, so any vars referenced
// inside the factory must be declared with vi.hoisted.
const { mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning } = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  return { mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: mockUpdate,
    query: { tracks: { findFirst: vi.fn() }, sessions: { findFirst: vi.fn() } },
  },
}));

vi.mock("../../src/services/bunny.ts", () => ({
  getVideoMeta: vi.fn(),
}));

import { getVideoMeta } from "../../src/services/bunny.ts";
const mockGetVideoMeta = getVideoMeta as ReturnType<typeof vi.fn>;

const SECRET = "test-webhook-secret";

async function postBunnyWebhook(
  body: Record<string, unknown>,
  opts: { secret?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.signature) headers["bunny-signature"] = opts.signature;
  const secret = opts.secret ?? SECRET;
  return testRequest(`/api/webhooks/bunny?secret=${encodeURIComponent(secret)}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/bunny", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturning.mockResolvedValue([{ id: 42 }]);
  });

  it("rejects missing secret", async () => {
    const res = await postBunnyWebhook(
      { VideoGuid: "abc", Status: 4 },
      { secret: "" },
    );
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects wrong secret", async () => {
    const res = await postBunnyWebhook(
      { VideoGuid: "abc", Status: 4 },
      { secret: "nope" },
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid HMAC signature when header is provided", async () => {
    const res = await postBunnyWebhook(
      { VideoGuid: "abc", Status: 4 },
      { signature: "deadbeef" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid HMAC signature", async () => {
    const body = { VideoGuid: "abc", Status: 4 };
    const rawBody = JSON.stringify(body);
    const sig = createHmac("sha256", SECRET).update(rawBody).digest("hex");

    mockGetVideoMeta.mockResolvedValueOnce({
      guid: "abc",
      title: "T",
      status: 4,
      length: 1234,
      width: 1920,
      height: 1080,
      framerate: 30,
      thumbnailFileName: "thumbnail.jpg",
      availableResolutions: "240p,360p,480p,720p,1080p",
    });

    const res = await postBunnyWebhook(body, { signature: sig });
    expect(res.status).toBe(200);
  });

  it("returns 400 when VideoGuid or Status is missing", async () => {
    const res = await postBunnyWebhook({ Status: 4 } as any);
    expect(res.status).toBe(400);
  });

  it("on Status=4 (finished) updates the matching session's video duration", async () => {
    mockGetVideoMeta.mockResolvedValueOnce({
      guid: "vid-guid-123",
      title: "Day 1",
      status: 4,
      length: 5400.7, // verifies rounding
      width: 1920,
      height: 1080,
      framerate: 30,
      thumbnailFileName: "thumbnail.jpg",
      availableResolutions: "240p,360p,480p,720p,1080p",
    });

    const res = await postBunnyWebhook({ VideoGuid: "vid-guid-123", Status: 4 });

    expect(res.status).toBe(200);
    expect(mockGetVideoMeta).toHaveBeenCalledWith("vid-guid-123");
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ videoDurationSeconds: 5401 }),
    );
  });

  it("on Status=4 with no matching session logs but still 200s (idempotent)", async () => {
    mockUpdateReturning.mockResolvedValueOnce([]);
    mockGetVideoMeta.mockResolvedValueOnce({
      guid: "orphan",
      title: "",
      status: 4,
      length: 0,
      width: 0,
      height: 0,
      framerate: 0,
      thumbnailFileName: null,
      availableResolutions: null,
    });

    const res = await postBunnyWebhook({ VideoGuid: "orphan", Status: 4 });
    expect(res.status).toBe(200);
  });

  it("on Status=5 (error) does not call update or getVideoMeta", async () => {
    const res = await postBunnyWebhook({ VideoGuid: "broken", Status: 5 });
    expect(res.status).toBe(200);
    expect(mockGetVideoMeta).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("on intermediate Status (e.g. 2 processing) ignores the event", async () => {
    const res = await postBunnyWebhook({ VideoGuid: "abc", Status: 2 });
    expect(res.status).toBe(200);
    expect(mockGetVideoMeta).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("acks even when getVideoMeta throws (don't make Bunny retry forever)", async () => {
    mockGetVideoMeta.mockRejectedValueOnce(new Error("Bunny API down"));
    const res = await postBunnyWebhook({ VideoGuid: "abc", Status: 4 });
    expect(res.status).toBe(200);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await testRequest(`/api/webhooks/bunny?secret=${SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
