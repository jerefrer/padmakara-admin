import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { config } from "../../src/config.ts";
import { testRequest } from "../helpers.ts";

const { mockUpdateSet, mockFindFirstEventVideo, mockApplyDelta } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn((_v: Record<string, unknown>) => ({ where: mockUpdateWhere }));
  return {
    mockUpdateSet,
    mockFindFirstEventVideo: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
    mockApplyDelta: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("../../src/db/index.ts", () => {
  const update = vi.fn(() => ({ set: mockUpdateSet }));
  const tx = { update };
  return {
    db: {
      update,
      transaction: vi.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
      query: { eventVideos: { findFirst: mockFindFirstEventVideo } },
    },
  };
});

vi.mock("../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/services/video-burn.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/video-burn.ts")>()),
  applyIntroDeltaInTransaction: mockApplyDelta,
}));

async function postBurnWebhook(body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const sig = createHmac("sha256", config.readAlong.webhookSecret).update(rawBody).digest("hex");
  return testRequest("/api/webhooks/video-burn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Signature": sig },
    body: rawBody,
  });
}

describe("POST /api/webhooks/video-burn — burn with an empty slide document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records burnedIntroMs 0 (not null) and the retained master key on a first burn", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 9, eventId: 3, burnedIntroMs: null });
    const res = await postBurnWebhook({
      jobId: "j", videoId: 9, status: "completed", bunnyVideoId: "guid-1",
      introMs: 0, outroMs: 0, masterS3Key: "video-burn/9/master.mkv",
    });
    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        bunnyVideoId: "guid-1", burnStatus: "done", burnedIntroMs: 0, masterS3Key: "video-burn/9/master.mkv",
      }),
    );
    expect(mockApplyDelta).toHaveBeenCalledWith(expect.anything(), 9, 0);
  });

  it("shifts progress by the whole intro when slides are first burned after an empty-document burn", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 9, eventId: 3, burnedIntroMs: 0 });
    await postBurnWebhook({
      jobId: "j2", videoId: 9, status: "completed", bunnyVideoId: "guid-2", introMs: 9600, outroMs: 0,
    });
    expect(mockApplyDelta).toHaveBeenCalledWith(expect.anything(), 9, 9600);
  });
});
