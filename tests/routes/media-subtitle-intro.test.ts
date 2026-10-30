import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../src/db/index.ts", () => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const findFirstEventVideo = vi.fn();
  return {
    db: {
      select,
      query: { eventVideos: { findFirst: findFirstEventVideo } },
      _limit: limit,
      _findFirstEventVideo: findFirstEventVideo,
    },
  };
});

vi.mock("../../src/services/s3.ts", () => ({
  getObjectText: vi.fn(),
  generatePresignedDownloadUrl: vi.fn(),
}));

vi.mock("../../src/services/media-access.ts", () => ({
  issueMat: vi.fn(),
  verifyMat: vi.fn(() => Promise.resolve({ svid: 7, gid: "guid" })),
}));

import { db } from "../../src/db/index.ts";
import { getObjectText } from "../../src/services/s3.ts";

const mockDb = db as unknown as {
  _limit: ReturnType<typeof vi.fn>;
  _findFirstEventVideo: ReturnType<typeof vi.fn>;
};

const RAW_VTT = "WEBVTT\n\n00:00:21.120 --> 00:00:22.600\nThis morning\n";

const SLIDES = {
  version: 1,
  intro: [
    {
      id: "logo",
      durationMs: 2500,
      fadeMs: 800,
      lines: [],
    },
    {
      id: "session",
      durationMs: 4000,
      fadeMs: 800,
      lines: [],
      subtitles: { pt: ["Sessão 1 de 4"] },
    },
  ],
  outro: [{ id: "end", durationMs: 4000, fadeMs: 800, lines: [], subtitles: { pt: ["Fim"] } }],
};

describe("GET /api/media/video/hls/:videoId/subs/:lang/track.vtt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb._limit.mockResolvedValue([{ s3Key: "events/E/subtitles/v7/pt.vtt" }]);
    vi.mocked(getObjectText).mockResolvedValue(RAW_VTT);
  });

  it("prepends the intro cues for the requested language before the existing cues", async () => {
    mockDb._findFirstEventVideo.mockResolvedValue({ slides: SLIDES });

    const res = await testRequest("/api/media/video/hls/7/subs/pt/track.vtt?mat=tok");
    const body = await res.text();

    expect(res.status).toBe(200);
    // Logo slide totals 4100 ms; the session slide holds from 4900 to 8900.
    expect(body).toContain("00:00:04.900 --> 00:00:08.900\nSessão 1 de 4");
    expect(body.indexOf("Sessão 1 de 4")).toBeLessThan(body.indexOf("This morning"));
    expect(body).toContain("00:00:21.120 --> 00:00:22.600\nThis morning");
  });

  it("keeps the X-TIMESTAMP-MAP header on top of the merged document", async () => {
    mockDb._findFirstEventVideo.mockResolvedValue({ slides: SLIDES });

    const res = await testRequest("/api/media/video/hls/7/subs/pt/track.vtt?mat=tok");
    const lines = (await res.text()).split("\n");

    expect(lines[0]).toBe("WEBVTT");
    expect(lines[1]).toMatch(/^X-TIMESTAMP-MAP=MPEGTS:\d+,LOCAL:00:00:00.000$/);
  });

  it("does not add intro cues from the outro", async () => {
    mockDb._findFirstEventVideo.mockResolvedValue({ slides: SLIDES });

    const body = await (await testRequest("/api/media/video/hls/7/subs/pt/track.vtt?mat=tok")).text();

    expect(body).not.toContain("Fim");
  });

  it("serves the raw cues when the video has no slide document", async () => {
    mockDb._findFirstEventVideo.mockResolvedValue({ slides: null });

    const body = await (await testRequest("/api/media/video/hls/7/subs/pt/track.vtt?mat=tok")).text();

    expect(body).toContain("This morning");
    expect(body.match(/-->/g)).toHaveLength(1);
  });

  it("serves the raw cues when the slides have no subtitles in the requested language", async () => {
    mockDb._findFirstEventVideo.mockResolvedValue({ slides: SLIDES });

    const body = await (await testRequest("/api/media/video/hls/7/subs/en/track.vtt?mat=tok")).text();

    expect(body.match(/-->/g)).toHaveLength(1);
  });

  it("rejects a request without a media access token", async () => {
    const res = await testRequest("/api/media/video/hls/7/subs/pt/track.vtt");

    expect(res.status).toBe(401);
  });
});
