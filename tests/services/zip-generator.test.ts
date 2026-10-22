import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";
import { existsSync } from "fs";

const {
  dbUpdateSets,
  dbWhere,
  findFirstMock,
  uploadedRef,
  uploadStreamMock,
  uploadFileMock,
  getObjectStreamMock,
  presignMock,
} = vi.hoisted(() => ({
  dbUpdateSets: [] as Array<Record<string, unknown>>,
  dbWhere: vi.fn((_vals: Record<string, unknown>) => Promise.resolve()),
  findFirstMock: vi.fn(),
  uploadedRef: { buffer: Buffer.alloc(0), path: "" },
  uploadStreamMock: vi.fn(),
  // Added when the ZIP builder moved to "write to temp file, then upload" — the mock
  // was never updated, and the dead test suite hid it. Reads the file back before the
  // generator deletes it, so tests can still assert on the real uploaded artifact.
  uploadFileMock: vi.fn(async (_key: string, filePath: string, _contentType?: string) => {
    const { readFile } = await import("fs/promises");
    uploadedRef.path = filePath;
    uploadedRef.buffer = await readFile(filePath);
  }),
  getObjectStreamMock: vi.fn(),
  presignMock: vi.fn(async (_key: string, _expiresIn?: number) => "https://example.test/zip"),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        dbUpdateSets.push(vals);
        return { where: () => dbWhere(vals) };
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
  generatePresignedDownloadUrl: presignMock,
}));

import { generateRetreatZip } from "../../src/services/zip-generator.ts";

function makeTrack(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Track ${id}`,
    s3Key: `events/x/${id}.mp3`,
    trackNumber: id,
    speaker: "JKR",
    languages: ["en"],
    isTranslation: false,
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    eventCode: "2024.04-GRP",
    titleEn: "Spring Retreat",
    titlePt: null,
    sessions: [
      {
        titleEn: "Morning",
        sessionNumber: 1,
        sessionDate: "2024-04-15",
        timePeriod: "morning",
        partNumber: null,
        tracks: [makeTrack(1, { title: "Intro" }), makeTrack(2, { title: "Teaching" })],
      },
      {
        titleEn: "Evening",
        sessionNumber: 2,
        sessionDate: "2024-04-15",
        timePeriod: "evening",
        partNumber: null,
        tracks: [makeTrack(3, { title: "Closing" })],
      },
    ],
    ...overrides,
  };
}

function eventWithTrackCount(count: number) {
  return makeEvent({
    sessions: [
      {
        titleEn: "Day 1",
        sessionNumber: 1,
        sessionDate: "2024-04-15",
        timePeriod: "morning",
        partNumber: null,
        tracks: Array.from({ length: count }, (_, i) => makeTrack(i + 1)),
      },
    ],
  });
}

/** Entry names as stored in the ZIP's local file headers (uncompressed). */
function zipText(): string {
  return uploadedRef.buffer.toString("utf8");
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  dbUpdateSets.length = 0;
  uploadedRef.buffer = Buffer.alloc(0);
  uploadedRef.path = "";
  dbWhere.mockImplementation(() => Promise.resolve());

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

  findFirstMock.mockResolvedValue(makeEvent());

  // The generator logs every step; keep test output readable.
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("generateRetreatZip - streaming behaviour", () => {
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

  it("removes the temp file after a successful upload", async () => {
    await generateRetreatZip("req-1", 42);

    expect(uploadedRef.path).not.toBe("");
    expect(existsSync(uploadedRef.path)).toBe(false);
  });
});

describe("generateRetreatZip - status lifecycle", () => {
  it("should move the request to processing before reading the event", async () => {
    await generateRetreatZip("req-1", 42);

    expect(dbUpdateSets[0]).toEqual(
      expect.objectContaining({ status: "processing", processingStartedAt: expect.any(Date) }),
    );
  });

  it("should record the total file count before archiving", async () => {
    await generateRetreatZip("req-1", 42);

    expect(dbUpdateSets[1]).toEqual(expect.objectContaining({ totalFiles: 3 }));
  });

  it("should set a 24-hour expiry and presign the ZIP for 24 hours", async () => {
    const before = Date.now();

    await generateRetreatZip("req-1", 42);

    const ready = dbUpdateSets.find((s) => s.status === "ready")!;
    const expiresAt = (ready.expiresAt as Date).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + day);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + day);
    expect(presignMock).toHaveBeenCalledWith("downloads/2024.04-GRP/spring-retreat.zip", 24 * 3600);
    expect(ready.downloadUrl).toBe("https://example.test/zip");
    expect(ready.processingCompletedAt).toEqual(expect.any(Date));
  });

  it("should complete an anonymous request (no userId)", async () => {
    await expect(generateRetreatZip("anon-req", 42, undefined)).resolves.toBeUndefined();

    expect(dbUpdateSets.at(-1)!.status).toBe("ready");
  });
});

describe("generateRetreatZip - progress updates", () => {
  it("should report progress every 5 files and on the last file", async () => {
    findFirstMock.mockResolvedValue(eventWithTrackCount(12));

    await generateRetreatZip("req-1", 42);

    const progress = dbUpdateSets
      .filter((s) => "processedFiles" in s && s.status === undefined)
      .map((s) => [s.processedFiles, s.progressPercent]);
    expect(progress).toEqual([
      [5, 41],
      [10, 83],
      [12, 100],
    ]);
  });

  it("should report a single 100% update when there are fewer than 5 tracks", async () => {
    await generateRetreatZip("req-1", 42);

    const progress = dbUpdateSets.filter((s) => "processedFiles" in s && s.status === undefined);
    expect(progress).toEqual([expect.objectContaining({ processedFiles: 3, progressPercent: 100 })]);
  });
});

describe("generateRetreatZip - track selection and naming", () => {
  it("should skip tracks that have no storage key", async () => {
    findFirstMock.mockResolvedValue(
      makeEvent({
        sessions: [
          {
            titleEn: "Morning",
            sessionNumber: 1,
            sessionDate: "2024-04-15",
            timePeriod: "morning",
            partNumber: null,
            tracks: [makeTrack(1), makeTrack(2, { s3Key: null })],
          },
        ],
      }),
    );

    await generateRetreatZip("req-1", 42);

    expect(getObjectStreamMock).toHaveBeenCalledTimes(1);
    expect(dbUpdateSets[1]).toEqual(expect.objectContaining({ totalFiles: 1 }));
  });

  it("should put each track in a '<date> - <session title>' folder", async () => {
    await generateRetreatZip("req-1", 42);

    expect(zipText()).toContain("2024-04-15 - Morning/");
    expect(zipText()).toContain("2024-04-15 - Evening/");
  });

  it("should name a folder 'Session N' when the session has no English title", async () => {
    findFirstMock.mockResolvedValue(
      makeEvent({
        sessions: [
          {
            titleEn: null,
            sessionNumber: 3,
            sessionDate: "2024-04-16",
            timePeriod: "morning",
            partNumber: null,
            tracks: [makeTrack(1)],
          },
        ],
      }),
    );

    await generateRetreatZip("req-1", 42);

    expect(zipText()).toContain("2024-04-16 - Session 3/");
  });

  it("should slugify the Portuguese title (accents stripped) when there is no English title", async () => {
    findFirstMock.mockResolvedValue(makeEvent({ titleEn: null, titlePt: "Retiro de Primavera — Lisboa" }));

    await generateRetreatZip("req-1", 42);

    expect(uploadFileMock.mock.calls[0]![0]).toBe("downloads/2024.04-GRP/retiro-de-primavera-lisboa.zip");
  });

  it("should fall back to the event code, then to event-<id>, for the ZIP name", async () => {
    findFirstMock.mockResolvedValue(makeEvent({ titleEn: null, titlePt: null, eventCode: null }));

    await generateRetreatZip("req-1", 42);

    expect(uploadFileMock.mock.calls[0]![0]).toBe("downloads/event-42/event-42.zip");
  });
});

describe("generateRetreatZip - failures", () => {
  it("should mark the request failed and rethrow when the event does not exist", async () => {
    findFirstMock.mockResolvedValue(undefined);

    await expect(generateRetreatZip("req-1", 42)).rejects.toThrow("Event 42 not found");

    expect(dbUpdateSets.at(-1)).toEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Event 42 not found",
        processingCompletedAt: expect.any(Date),
      }),
    );
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("should mark the request failed when no track has a storage key", async () => {
    findFirstMock.mockResolvedValue(
      makeEvent({
        sessions: [
          {
            titleEn: "Morning",
            sessionNumber: 1,
            sessionDate: "2024-04-15",
            timePeriod: "morning",
            partNumber: null,
            tracks: [makeTrack(1, { s3Key: null })],
          },
        ],
      }),
    );

    await expect(generateRetreatZip("req-1", 42)).rejects.toThrow("No tracks found for this event");

    expect(dbUpdateSets.at(-1)).toEqual(
      expect.objectContaining({ status: "failed", errorMessage: "No tracks found for this event" }),
    );
  });

  it("should keep going when one track cannot be read from storage", async () => {
    getObjectStreamMock.mockImplementation(async (key: string) => {
      if (key === "events/x/2.mp3") throw new Error("NoSuchKey");
      return Readable.from(Buffer.from("FAKE-AUDIO-DATA"));
    });

    await generateRetreatZip("req-1", 42);

    const ready = dbUpdateSets.find((s) => s.status === "ready")!;
    expect(ready).toBeDefined();
    expect(ready.processedFiles).toBe(2);
  });

  it("should mark the request failed and delete the temp file when the upload fails", async () => {
    uploadFileMock.mockImplementationOnce(async (_key: string, filePath: string) => {
      uploadedRef.path = filePath;
      throw new Error("R2 unavailable");
    });

    await expect(generateRetreatZip("req-1", 42)).rejects.toThrow("R2 unavailable");

    expect(dbUpdateSets.at(-1)).toEqual(
      expect.objectContaining({ status: "failed", errorMessage: "R2 unavailable" }),
    );
    expect(dbUpdateSets.some((s) => s.status === "ready")).toBe(false);
    expect(existsSync(uploadedRef.path)).toBe(false);
  });

  it("should rethrow the original error even when recording the failure also fails", async () => {
    findFirstMock.mockResolvedValue(undefined);
    dbWhere.mockImplementation((vals) =>
      vals.status === "failed" ? Promise.reject(new Error("db down")) : Promise.resolve(),
    );

    await expect(generateRetreatZip("req-1", 42)).rejects.toThrow("Event 42 not found");
  });

  it("should mark the request failed when no track could be added", async () => {
    getObjectStreamMock.mockRejectedValue(new Error("storage outage"));

    await generateRetreatZip("req-1", 42).catch(() => {});

    expect(dbUpdateSets.some((s) => s.status === "ready")).toBe(false);
    expect(dbUpdateSets.at(-1)).toEqual(expect.objectContaining({ status: "failed" }));
  });
});
