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
// submitSubtitleJob — per event_video (mocked db, AWS Batch, bunny)
// ---------------------------------------------------------------------------

const {
  mockSend,
  mockInsertReturning,
  mockDelete,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockFindFirstEventVideo,
  mockFindFirstEvent,
  mockFindManySessions,
  mockFindManyTracks,
  mockFindManyTranscripts,
  mockFindFirstSubtitleJob,
} = vi.hoisted(() => {
  const mockSend = vi.fn((_command?: unknown) => Promise.resolve({ jobId: "batch-job-1" }));
  const mockInsertReturning = vi.fn(() => Promise.resolve([{ id: "job-1" }]));
  const mockDeleteWhere = vi.fn(() => Promise.resolve());
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockFindFirstEventVideo = vi.fn<
    () => Promise<{ id: number; eventId: number; bunnyVideoId: string; position: number } | null>
  >(() => Promise.resolve({ id: 5, eventId: 1, bunnyVideoId: "vid-abc", position: 0 }));
  const mockFindFirstEvent = vi.fn(() => Promise.resolve({ id: 1, eventCode: "E1" }));
  const mockFindManySessions = vi.fn(() => Promise.resolve([{ id: 1 }, { id: 2 }]));
  const mockFindManyTracks = vi.fn(() =>
    Promise.resolve([{ trackNumber: 2 }, { trackNumber: 1 }, { trackNumber: 2 }]),
  );
  const mockFindManyTranscripts = vi.fn<
    () => Promise<Array<{ eventId: number; language: string; s3Key: string | null }>>
  >(() => Promise.resolve([{ eventId: 1, language: "en", s3Key: "events/E1/transcripts/en.pdf" }]));
  const mockFindFirstSubtitleJob = vi.fn<
    () => Promise<{ id: string; status: string; batchJobId: string | null } | null>
  >(() => Promise.resolve(null));
  return {
    mockSend,
    mockInsertReturning,
    mockDeleteWhere,
    mockDelete,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockFindFirstEventVideo,
    mockFindFirstEvent,
    mockFindManySessions,
    mockFindManyTracks,
    mockFindManyTranscripts,
    mockFindFirstSubtitleJob,
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
  DescribeJobsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  TerminateJobCommand: class {
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
    delete: mockDelete,
    query: {
      eventVideos: { findFirst: mockFindFirstEventVideo },
      events: { findFirst: mockFindFirstEvent },
      sessions: { findMany: mockFindManySessions },
      tracks: { findMany: mockFindManyTracks },
      transcripts: { findMany: mockFindManyTranscripts },
      subtitleJobs: { findFirst: mockFindFirstSubtitleJob },
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
    mockFindFirstEventVideo.mockResolvedValue({
      id: 5,
      eventId: 1,
      bunnyVideoId: "vid-abc",
      position: 0,
    });
    mockFindFirstEvent.mockResolvedValue({ id: 1, eventCode: "E1" });
    mockFindManySessions.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockFindManyTracks.mockResolvedValue([{ trackNumber: 2 }, { trackNumber: 1 }, { trackNumber: 2 }]);
    mockFindManyTranscripts.mockResolvedValue([
      { eventId: 1, language: "en", s3Key: "events/E1/transcripts/en.pdf" },
    ]);
    mockInsertReturning.mockResolvedValue([{ id: "job-1" }]);
    mockSend.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("inserts a job carrying videoId and passes SESSION_VIDEO_ID + VIDEO_AUDIO_URL to Batch", async () => {
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    const { buildMp4DownloadUrl } = await import("../../src/services/bunny.ts");

    const result = await submitSubtitleJob(5, { language: "en" });

    expect(result.videoId).toBe(5);
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
    expect(env.SESSION_ID).toBe("5");
    expect(env.SESSION_NUMBER).toBe("v5");
    expect(env.VIDEO_AUDIO_URL).toBe("https://cdn.example/vid-abc-240p.mp4");
    // Deduped + sorted union of trackNumber across all of the event's tracks.
    expect(env.TRACK_NUMBERS).toBe("1,2");
  });

  it("throws when the event_video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(999)).rejects.toThrow("Event video not found");
  });

  it("throws when the event has no tracks to align against", async () => {
    mockFindManyTracks.mockResolvedValueOnce([]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(5)).rejects.toThrow("Event has no tracks to align against");
  });

  it("refuses to submit when no matching-language transcript exists", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(5, { language: "en" })).rejects.toThrow(/transcript/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses to submit when the only transcript row has a null s3Key", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([{ eventId: 1, language: "en", s3Key: null }]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(5, { language: "en" })).rejects.toThrow(/transcript/i);
  });

  it("refuses to submit when the only transcript is in a different language", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([
      { eventId: 1, language: "pt", s3Key: "events/E1/transcripts/pt.pdf" },
    ]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(submitSubtitleJob(5, { language: "en" })).rejects.toThrow(/transcript/i);
  });

  it("proceeds without a transcript when acknowledgeNoTranscript is true", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    const result = await submitSubtitleJob(5, { language: "en", acknowledgeNoTranscript: true });
    expect(result.status).toBe("submitted");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("is not bypassable by omission — a caller that never sets acknowledgeNoTranscript is still refused", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([]);
    const { submitSubtitleJob } = await import("../../src/services/subtitles.ts");
    // No `options` object at all — mirrors a caller that only forwards
    // fields it knows about (e.g. an older/unmodified route).
    await expect(submitSubtitleJob(5)).rejects.toThrow(/transcript/i);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelSubtitleJob — terminate via AWS Batch + mark the row terminal
// ---------------------------------------------------------------------------

describe("deleteSubtitleJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSubtitleJob.mockResolvedValue(null);
  });

  it("deletes a terminal job row", async () => {
    mockFindFirstSubtitleJob.mockResolvedValueOnce({ id: "job-1", status: "failed" });
    const { deleteSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(deleteSubtitleJob("job-1")).resolves.toEqual({ id: "job-1", deleted: true });
    expect(mockDelete).toHaveBeenCalled();
  });

  it("refuses to delete a job that is still running", async () => {
    // Deleting a live job would orphan its Batch job, whose completion
    // webhook would then have no row to write back to.
    mockFindFirstSubtitleJob.mockResolvedValueOnce({ id: "job-2", status: "running" });
    const { deleteSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(deleteSubtitleJob("job-2")).rejects.toThrow(/cancel it before clearing/i);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("404s for an unknown job", async () => {
    const { deleteSubtitleJob } = await import("../../src/services/subtitles.ts");
    await expect(deleteSubtitleJob("nope")).rejects.toThrow(/not found/i);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("cancelSubtitleJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstSubtitleJob.mockResolvedValue(null);
    mockSend.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("terminates the Batch job and marks the row failed with a clear reason", async () => {
    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-1",
      status: "running",
      batchJobId: "batch-1",
    });
    const { cancelSubtitleJob } = await import("../../src/services/subtitles.ts");

    const result = await cancelSubtitleJob("job-1");

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Cancelled by an administrator");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as { input: { jobId: string; reason: string } };
    expect(command.input).toEqual({ jobId: "batch-1", reason: "Cancelled by an administrator" });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: "Cancelled by an administrator" }),
    );
  });

  it("rejects cancelling a job that has already finished", async () => {
    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-2",
      status: "completed",
      batchJobId: "batch-2",
    });
    const { cancelSubtitleJob } = await import("../../src/services/subtitles.ts");

    await expect(cancelSubtitleJob("job-2")).rejects.toThrow(/already finished/i);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("rejects cancelling a job that does not exist", async () => {
    mockFindFirstSubtitleJob.mockResolvedValueOnce(null);
    const { cancelSubtitleJob } = await import("../../src/services/subtitles.ts");

    await expect(cancelSubtitleJob("nope")).rejects.toThrow(/not found/i);
  });

  it("still marks the row cancelled when AWS Batch reports the job already finished", async () => {
    mockFindFirstSubtitleJob.mockResolvedValueOnce({
      id: "job-3",
      status: "queued",
      batchJobId: "batch-3",
    });
    mockSend.mockRejectedValueOnce(new Error("ClientException: job is not in a terminable state"));
    const { cancelSubtitleJob } = await import("../../src/services/subtitles.ts");

    const result = await cancelSubtitleJob("job-3");

    expect(result.status).toBe("failed");
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: "Cancelled by an administrator" }),
    );
  });
});
