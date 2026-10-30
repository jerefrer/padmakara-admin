import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import { planParts, contiguousParts, isVideoMasterKey, MAX_PARTS, MIB } from "../../../src/lib/video-multipart.ts";

vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedUploadUrl: vi.fn(),
  buildTrackS3Key: vi.fn(),
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

const BASE = "/api/admin/upload/video/multipart";
const KEY = "events/EVT-1/masters/1700000000000-master.mp4";

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

describe("planParts", () => {
  it("should use 64 MiB parts for a 16.29 GB master", () => {
    const size = Math.round(16.29 * 1024 ** 3);
    const { partSize, partCount } = planParts(size);
    expect(partSize).toBe(64 * MIB);
    expect(partCount).toBe(Math.ceil(size / (64 * MIB)));
    expect(partCount).toBe(261);
  });

  it("should raise the part size when 64 MiB parts would exceed 10,000", () => {
    // The route caps files at 200 GB (3,200 parts), so this only matters for
    // the helper's own invariant.
    const size = 1024 ** 4;
    const { partSize, partCount } = planParts(size);
    expect(partSize).toBeGreaterThan(64 * MIB);
    expect(partSize % MIB).toBe(0);
    expect(partCount).toBeLessThanOrEqual(MAX_PARTS);
  });

  it("should plan a single part for a tiny file", () => {
    expect(planParts(1).partCount).toBe(1);
  });
});

describe("isVideoMasterKey / contiguousParts", () => {
  it("should only accept keys under events/{code}/masters/", () => {
    expect(isVideoMasterKey(KEY)).toBe(true);
    expect(isVideoMasterKey("events/EVT-1/transcripts/a.pdf")).toBe(false);
    expect(isVideoMasterKey("users/1/secret")).toBe(false);
    expect(isVideoMasterKey("events/EVT-1/masters/../../x")).toBe(false);
  });

  it("should reject gaps, duplicates and empty lists", () => {
    expect(contiguousParts([])).toBeNull();
    expect(contiguousParts([{ partNumber: 1 }, { partNumber: 3 }])).toBeNull();
    expect(contiguousParts([{ partNumber: 2 }, { partNumber: 3 }])).toBeNull();
    expect(contiguousParts([{ partNumber: 1 }, { partNumber: 1 }])).toBeNull();
    expect(contiguousParts([{ partNumber: 2 }, { partNumber: 1 }])?.map((p) => p.partNumber)).toEqual([1, 2]);
  });
});

describe("POST /api/admin/upload/video/multipart/create", () => {
  const valid = { eventCode: "EVT-1", filename: "master.mp4", contentType: "video/mp4", size: Math.round(16.29 * 1024 ** 3) };

  it("should create the upload and return plan for a 16.29 GB file", async () => {
    mCreate.mockResolvedValueOnce("upload-1");
    const { status, body } = await post("create", valid);
    expect(status).toBe(200);
    expect(body).toMatchObject({ uploadId: "upload-1", partSize: 64 * MIB, partCount: 261 });
    expect(body.s3Key).toMatch(/^events\/EVT-1\/masters\/\d+-master\.mp4$/);
    expect(mCreate).toHaveBeenCalledWith(body.s3Key, "video/mp4");
  });

  it("should return 400 when size is missing, zero or above 200 GB", async () => {
    for (const size of [undefined, 0, 201 * 1024 ** 3]) {
      const { status } = await post("create", { ...valid, size });
      expect(status).toBe(400);
    }
    expect(mCreate).not.toHaveBeenCalled();
  });

  it("should return 401 without a token and 403 for non-admins", async () => {
    expect((await post("create", valid, null)).status).toBe(401);
    expect((await post("create", valid, "user")).status).toBe(403);
  });
});

describe("POST /api/admin/upload/video/multipart/presign-parts", () => {
  it("should return a URL per requested part number", async () => {
    mPresign.mockImplementation(async (_k: string, _u: string, n: number) => `https://s3/part-${n}`);
    const { status, body } = await post("presign-parts", { s3Key: KEY, uploadId: "u", partNumbers: [1, 2, 7] });
    expect(status).toBe(200);
    expect(body.urls).toEqual({ 1: "https://s3/part-1", 2: "https://s3/part-2", 7: "https://s3/part-7" });
    expect(mPresign).toHaveBeenCalledWith(KEY, "u", 7, 6 * 3600);
  });

  it("should refuse keys outside the masters prefix", async () => {
    const { status } = await post("presign-parts", { s3Key: "events/EVT-1/transcripts/a.pdf", uploadId: "u", partNumbers: [1] });
    expect(status).toBe(400);
    expect(mPresign).not.toHaveBeenCalled();
  });

  it("should reject more than 100 parts and out-of-range numbers", async () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await post("presign-parts", { s3Key: KEY, uploadId: "u", partNumbers: many })).status).toBe(400);
    expect((await post("presign-parts", { s3Key: KEY, uploadId: "u", partNumbers: [0] })).status).toBe(400);
    expect((await post("presign-parts", { s3Key: KEY, uploadId: "u", partNumbers: [10001] })).status).toBe(400);
  });
});

describe("POST /api/admin/upload/video/multipart/complete", () => {
  it("should complete with the ETags S3 lists, sorted", async () => {
    mList.mockResolvedValueOnce([
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ]);
    const { status, body } = await post("complete", { s3Key: KEY, uploadId: "u" });
    expect(status).toBe(200);
    expect(body).toEqual({ s3Key: KEY });
    expect(mComplete).toHaveBeenCalledWith(KEY, "u", [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);
  });

  it("should return 400 and not complete when parts have a gap", async () => {
    mList.mockResolvedValueOnce([{ partNumber: 1, etag: "a" }, { partNumber: 3, etag: "c" }]);
    const { status, body } = await post("complete", { s3Key: KEY, uploadId: "u" });
    expect(status).toBe(400);
    expect(body.code ?? body.error?.code ?? JSON.stringify(body)).toContain("INCOMPLETE_UPLOAD");
    expect(mComplete).not.toHaveBeenCalled();
  });

  it("should refuse keys outside the masters prefix", async () => {
    const { status } = await post("complete", { s3Key: "x/y", uploadId: "u" });
    expect(status).toBe(400);
    expect(mList).not.toHaveBeenCalled();
  });

  it("should surface S3 errors as 500", async () => {
    mList.mockResolvedValueOnce([{ partNumber: 1, etag: "a" }]);
    mComplete.mockRejectedValueOnce(new Error("S3 down"));
    const { status } = await post("complete", { s3Key: KEY, uploadId: "u" });
    expect(status).toBe(500);
  });
});

describe("POST /api/admin/upload/video/multipart/abort", () => {
  it("should abort the upload", async () => {
    const { status, body } = await post("abort", { s3Key: KEY, uploadId: "u" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mAbort).toHaveBeenCalledWith(KEY, "u");
  });

  it("should refuse keys outside the masters prefix", async () => {
    const { status } = await post("abort", { s3Key: "events/EVT-1/a.mp3", uploadId: "u" });
    expect(status).toBe(400);
    expect(mAbort).not.toHaveBeenCalled();
  });
});
