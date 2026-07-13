import { describe, it, expect, vi, beforeEach } from "vitest";
import { captionUploadBody } from "../../src/services/bunny-captions.ts";

describe("captionUploadBody", () => {
  it("base64-encodes the VTT into the Bunny payload", () => {
    const body = captionUploadBody("en", "English", "WEBVTT\n\n");
    expect(body.srclang).toBe("en");
    expect(body.label).toBe("English");
    expect(Buffer.from(body.captionsFile, "base64").toString()).toBe("WEBVTT\n\n");
  });
});

// ---------------------------------------------------------------------------
// submitSubtitleJob — per session_video (mocked db, AWS Batch, bunny)
// ---------------------------------------------------------------------------

const {
  mockSend,
  mockInsertReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockFindFirstSessionVideo,
  mockFindFirstSession,
  mockFindFirstEvent,
  mockFindManyTracks,
} = vi.hoisted(() => {
  const mockSend = vi.fn((_command?: unknown) => Promise.resolve({ jobId: "batch-job-1" }));
  const mockInsertReturning = vi.fn(() => Promise.resolve([{ id: "job-1" }]));
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockFindFirstSessionVideo = vi.fn<
    () => Promise<{ id: number; sessionId: number; bunnyVideoId: string; position: number } | null>
  >(() => Promise.resolve({ id: 5, sessionId: 1, bunnyVideoId: "vid-abc", position: 0 }));
  const mockFindFirstSession = vi.fn(() =>
    Promise.resolve({ id: 1, eventId: 1, sessionNumber: 2 }),
  );
  const mockFindFirstEvent = vi.fn(() => Promise.resolve({ id: 1, eventCode: "E1" }));
  const mockFindManyTracks = vi.fn(() =>
    Promise.resolve([{ trackNumber: 2 }, { trackNumber: 1 }]),
  );
  return {
    mockSend,
    mockInsertReturning,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockFindFirstSessionVideo,
    mockFindFirstSession,
    mockFindFirstEvent,
    mockFindManyTracks,
  };
});

vi.mock("@aws-sdk/client-batch", () => ({
  BatchClient: class {
    send(command: unknown) {
      return mockSend(command);
    }
  },
  SubmitJobCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: mockInsertReturning })),
    })),
    update: mockUpdate,
    query: {
      sessionVideos: { findFirst: mockFindFirstSessionVideo },
      sessions: { findFirst: mockFindFirstSession },
      events: { findFirst: mockFindFirstEvent },
      tracks: { findMany: mockFindManyTracks },
    },
  },
}));

vi.mock("../../src/services/bunny.ts", () => ({
  buildMp4DownloadUrl: vi.fn(() => ({
    url: "https://cdn.example/vid-abc-240p.mp4",
    expiresAt: 0,
  })),
}));

describe("submitSubtitleJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSessionVideo.mockResolvedValue({
      id: 5,
      sessionId: 1,
      bunnyVideoId: "vid-abc",
      position: 0,
    });
    mockFindFirstSession.mockResolvedValue({ id: 1, eventId: 1, sessionNumber: 2 });
    mockFindFirstEvent.mockResolvedValue({ id: 1, eventCode: "E1" });
    mockFindManyTracks.mockResolvedValue([{ trackNumber: 2 }, { trackNumber: 1 }]);
    mockInsertReturning.mockResolvedValue([{ id: "job-1" }]);
    mockSend.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("inserts a job carrying sessionVideoId and passes SESSION_VIDEO_ID + VIDEO_AUDIO_URL to Batch", async () => {
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    const { buildMp4DownloadUrl } = await import("../../src/services/bunny.ts");

    const result = await submitSubtitleJob(5, { language: "en" });

    expect(result.sessionId).toBe(1);
    expect(result.sessionVideoId).toBe(5);
    expect(result.jobId).toBe("job-1");
    expect(buildMp4DownloadUrl).toHaveBeenCalledWith("vid-abc", "240p");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as {
      input: { containerOverrides: { environment: Array<{ name: string; value: string }> } };
    };
    const env = Object.fromEntries(
      command.input.containerOverrides.environment.map((e) => [e.name, e.value]),
    );
    expect(env.SESSION_VIDEO_ID).toBe("5");
    expect(env.SESSION_ID).toBe("1");
    expect(env.VIDEO_AUDIO_URL).toBe("https://cdn.example/vid-abc-240p.mp4");
    expect(env.TRACK_NUMBERS).toBe("1,2");
  });

  it("throws when the session_video does not exist", async () => {
    mockFindFirstSessionVideo.mockResolvedValueOnce(null);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(999)).rejects.toThrow("Session video not found");
  });
});
