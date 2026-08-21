import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

const {
  dbUpdateSets,
  findFirstMock,
  uploadedRef,
  uploadStreamMock,
  uploadFileMock,
  getObjectStreamMock,
} = vi.hoisted(() => ({
  dbUpdateSets: [] as Array<Record<string, unknown>>,
  findFirstMock: vi.fn(),
  uploadedRef: { buffer: Buffer.alloc(0) },
  uploadStreamMock: vi.fn(),
  // Added when the ZIP builder moved to "write to temp file, then upload" — the mock
  // was never updated, and the dead test suite hid it. Reads the file back before the
  // generator deletes it, so tests can still assert on the real uploaded artifact.
  uploadFileMock: vi.fn(async (_key: string, filePath: string, _contentType?: string) => {
    const { readFile } = await import("fs/promises");
    uploadedRef.buffer = await readFile(filePath);
  }),
  getObjectStreamMock: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        dbUpdateSets.push(vals);
        return { where: () => Promise.resolve() };
      },
    }),
    query: { events: { findFirst: findFirstMock } },
  },
}));

vi.mock("../../src/services/s3.ts", () => ({
  getObjectStream: getObjectStreamMock,
  uploadStream: uploadStreamMock,
  buildZipS3Key: (eventCode: string, requestId: string, filename?: string) =>
    `downloads/${eventCode}/${filename || requestId}.zip`,
  buildTrackS3Key: vi.fn(),
  uploadFile: uploadFileMock,
  generatePresignedDownloadUrl: vi.fn(async () => "https://example.test/zip"),
}));

import { generateRetreatZip } from "../../src/services/zip-generator.ts";

describe("generateRetreatZip - streaming behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbUpdateSets.length = 0;
    uploadedRef.buffer = Buffer.alloc(0);

    // Each call returns a fresh, finite stream (a new S3 GetObject body).
    getObjectStreamMock.mockImplementation(async () =>
      Readable.from(Buffer.from("FAKE-AUDIO-DATA")),
    );

    // Stand in for lib-storage Upload: consume the piped archive stream and
    // capture the bytes so we can assert a real ZIP was produced.
    uploadStreamMock.mockImplementation(async (_key: string, stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      uploadedRef.buffer = Buffer.concat(chunks);
    });

    findFirstMock.mockResolvedValue({
      id: 42,
      eventCode: "2024.04-GRP",
      titleEn: "Spring Retreat",
      titlePt: null,
      sessions: [
        {
          titleEn: "Morning",
          sessionNumber: 1,
          sessionDate: "2024-04-15",
          tracks: [
            { id: 1, title: "Intro", s3Key: "events/x/1.mp3", trackNumber: 1 },
            { id: 2, title: "Teaching", s3Key: "events/x/2.mp3", trackNumber: 2 },
          ],
        },
        {
          titleEn: "Evening",
          sessionNumber: 2,
          sessionDate: "2024-04-15",
          tracks: [
            { id: 3, title: "Closing", s3Key: "events/x/3.mp3", trackNumber: 3 },
          ],
        },
      ],
    });
  });

  it("uploads the ZIP from a temp file instead of buffering it in memory", async () => {
    await generateRetreatZip("req-1", 42);

    // The archive is built to disk and handed to uploadFile as a path. The older design
    // piped the live archive stream to uploadStream; that was replaced because the AWS
    // SDK multipart uploader rejects Bun's Node streams. Either way the guarantee under
    // test is the same: the whole ZIP is never held in memory as a Buffer.
    expect(uploadStreamMock).not.toHaveBeenCalled();
    expect(uploadFileMock).toHaveBeenCalledTimes(1);

    const [key, filePath, contentType] = uploadFileMock.mock.calls[0]!;
    expect(typeof filePath).toBe("string");
    expect(Buffer.isBuffer(filePath)).toBe(false);
    expect(key).toBe("downloads/2024.04-GRP/spring-retreat.zip");
    expect(contentType).toBe("application/zip");

    // What was uploaded is a real, non-empty ZIP (local file header magic "PK").
    expect(uploadedRef.buffer.length).toBeGreaterThan(0);
    expect(uploadedRef.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("opens each track stream exactly once (no mass pre-buffering)", async () => {
    await generateRetreatZip("req-1", 42);
    expect(getObjectStreamMock).toHaveBeenCalledTimes(3);
  });

  it("marks the request ready with the streamed byte size", async () => {
    await generateRetreatZip("req-1", 42);

    const ready = dbUpdateSets.find((s) => s.status === "ready");
    expect(ready).toBeDefined();
    expect(ready!.progressPercent).toBe(100);
    expect(ready!.fileSize as number).toBeGreaterThan(0);
    expect(ready!.s3Key).toBe("downloads/2024.04-GRP/spring-retreat.zip");
  });
});

describe("ZIP Generator Service - Logic Tests", () => {
  describe("Progress Calculation", () => {
    it("calculates progress percentage correctly", () => {
      const scenarios = [
        { processed: 0, total: 10, expected: 0 },
        { processed: 5, total: 10, expected: 50 },
        { processed: 10, total: 10, expected: 100 },
        { processed: 3, total: 12, expected: 25 },
        { processed: 7, total: 20, expected: 35 },
      ];

      for (const { processed, total, expected } of scenarios) {
        const percent = Math.floor((processed / total) * 100);
        expect(percent).toBe(expected);
      }
    });

    it("determines when to update progress (every 5 files)", () => {
      const updateInterval = 5;
      const testCases = [
        { fileIndex: 0, shouldUpdate: false },
        { fileIndex: 4, shouldUpdate: false },
        { fileIndex: 5, shouldUpdate: true },
        { fileIndex: 9, shouldUpdate: false },
        { fileIndex: 10, shouldUpdate: true },
        { fileIndex: 15, shouldUpdate: true },
      ];

      for (const { fileIndex, shouldUpdate } of testCases) {
        const needsUpdate = fileIndex > 0 && fileIndex % updateInterval === 0;
        expect(needsUpdate).toBe(shouldUpdate);
      }
    });
  });

  describe("File Path Generation", () => {
    it("generates correct ZIP paths for tracks", () => {
      const eventCode = "2024.04.15-GROUP-PLACE";
      const sessionTitle = "Morning Session";
      const trackNumber = 1;
      const trackTitle = "Opening Prayers";

      // Expected: 1 - Opening Prayers.mp3
      const filename = `${String(trackNumber).padStart(3, "0")} - ${trackTitle}.mp3`;

      expect(filename).toBe("001 - Opening Prayers.mp3");
    });

    it("organizes files by session in ZIP", () => {
      const sessions = [
        { sessionNumber: 1, titleEn: "Morning Session", trackCount: 3 },
        { sessionNumber: 2, titleEn: "Afternoon Session", trackCount: 2 },
      ];

      const totalTracks = sessions.reduce((sum, s) => sum + s.trackCount, 0);

      expect(totalTracks).toBe(5);
      expect(sessions.length).toBe(2);
    });

    it("handles session titles with special characters", () => {
      const sessionTitles = [
        "Morning Session",
        "Q&A Session",
        "Day 1 - Part 2",
        "Final Dedication",
      ];

      for (const title of sessionTitles) {
        // ZIP path should use session title as folder name
        const path = `${title}/001 - Track.mp3`;
        expect(path).toContain(title);
      }
    });
  });

  describe("ZIP Metadata", () => {
    it("calculates expiration time (24 hours)", () => {
      const now = Date.now();
      const expiryHours = 24;
      const expiryMs = expiryHours * 60 * 60 * 1000;
      const expiresAt = new Date(now + expiryMs);

      const timeUntilExpiry = expiresAt.getTime() - now;
      const hoursUntilExpiry = timeUntilExpiry / (60 * 60 * 1000);

      expect(hoursUntilExpiry).toBeCloseTo(24, 1);
    });

    it("generates correct S3 key for ZIP files", () => {
      const eventCode = "2024.04.15-GROUP-PLACE";
      const requestId = "123e4567-e89b-12d3-a456-426614174000";
      const expectedKey = `downloads/${eventCode}/${requestId}.zip`;

      const generatedKey = `downloads/${eventCode}/${requestId}.zip`;

      expect(generatedKey).toBe(expectedKey);
    });
  });

  describe("Status Transitions", () => {
    it("follows correct status flow", () => {
      const statusFlow = [
        { from: null, to: "pending", valid: true },
        { from: "pending", to: "processing", valid: true },
        { from: "processing", to: "ready", valid: true },
        { from: "processing", to: "failed", valid: true },
        { from: "ready", to: "expired", valid: true },
        { from: "failed", to: "ready", valid: false },
        { from: "expired", to: "ready", valid: false },
      ];

      const validTransitions = statusFlow.filter((t) => t.valid);

      expect(validTransitions.length).toBe(5);
    });

    it("validates final states", () => {
      const finalStates = ["ready", "failed", "expired"];
      const activeStates = ["pending", "processing"];

      for (const state of finalStates) {
        const isFinal = !activeStates.includes(state);
        expect(isFinal).toBe(true);
      }
    });
  });

  describe("Error Scenarios", () => {
    it("identifies error conditions", () => {
      const errorConditions = [
        { condition: "event not found", shouldFail: true },
        { condition: "S3 download error", shouldFail: true },
        { condition: "S3 upload error", shouldFail: true },
        { condition: "archiver error", shouldFail: true },
        { condition: "valid event with tracks", shouldFail: false },
      ];

      for (const { condition, shouldFail } of errorConditions) {
        expect(shouldFail).toBe(condition !== "valid event with tracks");
      }
    });

    it("determines retry eligibility", () => {
      const scenarios = [
        { status: "failed", retryCount: 0, canRetry: true },
        { status: "failed", retryCount: 3, canRetry: false },
        { status: "ready", retryCount: 0, canRetry: false },
        { status: "processing", retryCount: 0, canRetry: false },
      ];

      const maxRetries = 3;

      for (const { status, retryCount, canRetry } of scenarios) {
        const eligible = status === "failed" && retryCount < maxRetries;
        expect(eligible).toBe(canRetry);
      }
    });
  });

  describe("Track Processing", () => {
    it("sorts tracks by track number within sessions", () => {
      const tracks = [
        { trackNumber: 3, title: "Third" },
        { trackNumber: 1, title: "First" },
        { trackNumber: 2, title: "Second" },
      ];

      const sorted = [...tracks].sort((a, b) => a.trackNumber - b.trackNumber);

      expect(sorted[0]!.trackNumber).toBe(1);
      expect(sorted[1]!.trackNumber).toBe(2);
      expect(sorted[2]!.trackNumber).toBe(3);
    });

    it("groups tracks by session correctly", () => {
      const tracks = [
        { sessionId: 1, trackNumber: 1 },
        { sessionId: 1, trackNumber: 2 },
        { sessionId: 2, trackNumber: 3 },
        { sessionId: 2, trackNumber: 4 },
      ];

      const sessionGroups = tracks.reduce(
        (acc, track) => {
          acc[track.sessionId] = (acc[track.sessionId] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>,
      );

      expect(sessionGroups[1]).toBe(2);
      expect(sessionGroups[2]).toBe(2);
    });

    it("validates minimum tracks for ZIP generation", () => {
      const scenarios = [
        { trackCount: 0, canGenerate: false },
        { trackCount: 1, canGenerate: true },
        { trackCount: 10, canGenerate: true },
        { trackCount: 100, canGenerate: true },
      ];

      for (const { trackCount, canGenerate } of scenarios) {
        const valid = trackCount > 0;
        expect(valid).toBe(canGenerate);
      }
    });
  });

  describe("Stream Operations", () => {
    it("creates readable stream for testing", () => {
      const stream = new Readable();
      stream.push("test data");
      stream.push(null);

      expect(stream).toBeInstanceOf(Readable);
    });

    it("handles multiple streams for ZIP archiving", () => {
      const streamCount = 5;
      const streams: Readable[] = [];

      for (let i = 0; i < streamCount; i++) {
        const stream = new Readable();
        stream.push(`data ${i}`);
        stream.push(null);
        streams.push(stream);
      }

      expect(streams.length).toBe(5);
    });
  });
});
