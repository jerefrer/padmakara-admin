import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { config } from "../../src/config.ts";
import { testRequest } from "../helpers.ts";

const { mockUpdateSet, mockFindFirstEventVideo } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  return {
    mockUpdateSet: vi.fn((_v: Record<string, unknown>) => ({ where: mockUpdateWhere })),
    mockFindFirstEventVideo: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
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
  applyIntroDeltaInTransaction: vi.fn(() => Promise.resolve()),
}));

async function post(body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const sig = createHmac("sha256", config.readAlong.webhookSecret).update(rawBody).digest("hex");
  return testRequest("/api/webhooks/video-burn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Signature": sig },
    body: rawBody,
  });
}

describe("POST /api/webhooks/video-burn — disk metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should store the master size and peak disk use on success", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 9, eventId: 3, burnedIntroMs: null });
    const res = await post({
      jobId: "j", videoId: 9, status: "completed", bunnyVideoId: "g", introMs: 0,
      masterBytes: 16_300_000_000, peakWorkDirBytes: 33_100_000_000,
    });
    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnMasterBytes: 16_300_000_000, burnPeakDiskBytes: 33_100_000_000 }),
    );
  });

  it("should store what was measured so far on failure", async () => {
    const res = await post({
      jobId: "j", videoId: 9, status: "failed", error: "ENOSPC", masterBytes: 5_000, peakWorkDirBytes: 12_000,
    });
    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnStatus: "failed", burnMasterBytes: 5_000, burnPeakDiskBytes: 12_000 }),
    );
  });

  it("should leave the columns untouched when an old container sends no metrics", async () => {
    await post({ jobId: "j", videoId: 9, status: "failed", error: "boom" });
    const set = mockUpdateSet.mock.calls[0]?.[0] ?? {};
    expect(set).not.toHaveProperty("burnMasterBytes");
    expect(set).not.toHaveProperty("burnPeakDiskBytes");
  });

  it("should ignore malformed metric values", async () => {
    await post({ jobId: "j", videoId: 9, status: "failed", masterBytes: "big", peakWorkDirBytes: -1 });
    const set = mockUpdateSet.mock.calls[0]?.[0] ?? {};
    expect(set).not.toHaveProperty("burnMasterBytes");
    expect(set).not.toHaveProperty("burnPeakDiskBytes");
  });
});
