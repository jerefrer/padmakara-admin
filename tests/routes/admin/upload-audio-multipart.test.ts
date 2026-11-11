import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import { planParts, isTrackAudioKey, AUDIO_PART_SIZE, MIB } from "../../../src/lib/video-multipart.ts";

vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedUploadUrl: vi.fn(),
  buildTrackS3Key: vi.fn((eventCode: string, _session: number, filename: string) => `events/${eventCode}/${filename}`),
  buildTranscriptS3Key: vi.fn(),
  buildEventFileS3Key: vi.fn(),
  createMultipartUpload: vi.fn(),
  generatePresignedPartUrl: vi.fn(),
  listUploadedParts: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: { query: { users: { findFirst: vi.fn() } }, select: vi.fn() },
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import {
  createMultipartUpload,
  generatePresignedPartUrl,
  listUploadedParts,
  completeMultipartUpload,
  abortMultipartUpload,
} from "../../../src/services/s3.ts";

const mCreate = createMultipartUpload as ReturnType<typeof vi.fn>;
const mPresign = generatePresignedPartUrl as ReturnType<typeof vi.fn>;
const mList = listUploadedParts as ReturnType<typeof vi.fn>;
const mComplete = completeMultipartUpload as ReturnType<typeof vi.fn>;
const mAbort = abortMultipartUpload as ReturnType<typeof vi.fn>;

const BASE = "/api/admin/upload/audio/multipart";
const KEY = "events/EVT-1/001 - 20260910 - JKR - Morning.mp3";

async function post(path: string, payload: unknown, role: "admin" | "user" | null = "admin") {
  const headers: Record<string, string> = {};
  if (role) {
    const token = await createAccessToken({ sub: 1, email: "a@test.com", role });
    headers.Authorization = `Bearer ${token}`;
  }
  return testJson(`${BASE}/${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planParts with the audio part size", () => {
  it("should cut a 72 MB recording into 8 MiB parts", () => {
    const size = 72 * 1000 * 1000;
    expect(planParts(size, AUDIO_PART_SIZE)).toEqual({ partSize: 8 * MIB, partCount: 9 });
  });
});

describe("isTrackAudioKey", () => {
  it("should accept only a file directly under events/{code}/", () => {
    expect(isTrackAudioKey(KEY)).toBe(true);
    expect(isTrackAudioKey("events/EVT-1/masters/1700000000000-master.mp4")).toBe(false);
    expect(isTrackAudioKey("events/EVT-1/transcripts/a.pdf")).toBe(false);
    expect(isTrackAudioKey("users/1/secret")).toBe(false);
    expect(isTrackAudioKey("events/EVT-1/..")).toBe(false);
    expect(isTrackAudioKey("events/../x.mp3")).toBe(false);
  });
});

describe("POST /api/admin/upload/audio/multipart/create", () => {
  const valid = { eventCode: "EVT-1", filename: "001 - 20260910 - JKR - Morning.mp3", contentType: "audio/mpeg", size: 72 * 1000 * 1000 };

  it("should create the upload at the track's key with 8 MiB parts", async () => {
    mCreate.mockResolvedValueOnce("upload-1");
    const { status, body } = await post("create", valid);
    expect(status).toBe(200);
    expect(body).toEqual({ uploadId: "upload-1", s3Key: KEY, partSize: 8 * MIB, partCount: 9 });
    expect(mCreate).toHaveBeenCalledWith(KEY, "audio/mpeg");
  });

  it("should return 400 when size is missing, zero or above 5 GB", async () => {
    for (const size of [undefined, 0, 6 * 1024 ** 3]) {
      expect((await post("create", { ...valid, size })).status).toBe(400);
    }
    expect(mCreate).not.toHaveBeenCalled();
  });

  it("should return 401 without a token and 403 for non-admins", async () => {
    expect((await post("create", valid, null)).status).toBe(401);
    expect((await post("create", valid, "user")).status).toBe(403);
  });
});

describe("audio multipart part routes", () => {
  it("should sign the requested parts of an audio key", async () => {
    mPresign.mockImplementation(async (_k: string, _u: string, n: number) => `https://s3.test/part-${n}`);
    const { status, body } = await post("presign-parts", { s3Key: KEY, uploadId: "u1", partNumbers: [1, 2] });
    expect(status).toBe(200);
    expect(body).toEqual({ urls: { "1": "https://s3.test/part-1", "2": "https://s3.test/part-2" } });
  });

  it("should refuse to sign or touch a key that is not a track's audio", async () => {
    const master = "events/EVT-1/masters/1700000000000-master.mp4";
    expect((await post("presign-parts", { s3Key: master, uploadId: "u1", partNumbers: [1] })).status).toBe(400);
    expect((await post("complete", { s3Key: master, uploadId: "u1" })).status).toBe(400);
    expect((await post("list-parts", { s3Key: master, uploadId: "u1" })).status).toBe(400);
    expect((await post("abort", { s3Key: master, uploadId: "u1" })).status).toBe(400);
    expect(mPresign).not.toHaveBeenCalled();
    expect(mComplete).not.toHaveBeenCalled();
    expect(mList).not.toHaveBeenCalled();
    expect(mAbort).not.toHaveBeenCalled();
  });

  it("should complete from the parts storage holds", async () => {
    mList.mockResolvedValueOnce([
      { partNumber: 2, etag: "b", size: 10 },
      { partNumber: 1, etag: "a", size: 8 * MIB },
    ]);
    const { status, body } = await post("complete", { s3Key: KEY, uploadId: "u1" });
    expect(status).toBe(200);
    expect(body).toEqual({ s3Key: KEY });
    expect(mComplete).toHaveBeenCalledWith(KEY, "u1", [
      { partNumber: 1, etag: "a", size: 8 * MIB },
      { partNumber: 2, etag: "b", size: 10 },
    ]);
  });

  it("should list the parts already uploaded so a reload can resume", async () => {
    mList.mockResolvedValueOnce([{ partNumber: 1, etag: "a", size: 8 * MIB }]);
    const { status, body } = await post("list-parts", { s3Key: KEY, uploadId: "u1" });
    expect(status).toBe(200);
    expect(body).toEqual({ parts: [{ partNumber: 1, size: 8 * MIB, etag: "a" }] });
  });
});
