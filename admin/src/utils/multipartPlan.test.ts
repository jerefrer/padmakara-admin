import { describe, it, expect } from "vitest";
import {
  PART_RETRY_DELAYS_MS,
  decidePartRetry,
  nextPresignBatch,
  overallFraction,
  partRange,
  RESUME_MAX_AGE_MS,
  resumeStorageKey,
  parseResumeEntry,
  partsToSkip,
  bytesOfParts,
} from "./multipartPlan";

describe("partRange", () => {
  it("should cover the file exactly with a short last part", () => {
    const size = 150;
    expect(partRange(1, 64, size)).toEqual({ start: 0, end: 64 });
    expect(partRange(2, 64, size)).toEqual({ start: 64, end: 128 });
    expect(partRange(3, 64, size)).toEqual({ start: 128, end: 150 });
  });
});

describe("decidePartRetry", () => {
  it("should back off 1s, 2s, 4s, 8s, 16s, 30s then fail on the 7th failure", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) => {
      const d = decidePartRetry(n, 0);
      return d.action === "retry" ? d.delayMs : -1;
    });
    expect(delays).toEqual([...PART_RETRY_DELAYS_MS]);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(decidePartRetry(7, 0)).toEqual({ action: "fail" });
  });

  it("should re-presign on 403 and retry transient statuses as-is", () => {
    expect(decidePartRetry(1, 403)).toEqual({ action: "retry", delayMs: 1000, represign: true });
    for (const status of [0, 408, 429, 500, 503]) {
      expect(decidePartRetry(1, status)).toEqual({ action: "retry", delayMs: 1000, represign: false });
    }
  });

  it("should fail immediately on other 4xx statuses", () => {
    expect(decidePartRetry(1, 400)).toEqual({ action: "fail" });
    expect(decidePartRetry(1, 404)).toEqual({ action: "fail" });
  });
});

describe("nextPresignBatch", () => {
  it("should start at the requested part and skip parts that are not pending", () => {
    const pending = new Set([3, 5, 6, 9]);
    expect(nextPresignBatch(3, 10, (n) => pending.has(n))).toEqual([3, 5, 6, 9]);
  });

  it("should cap the batch size", () => {
    expect(nextPresignBatch(1, 500, () => true, 100)).toHaveLength(100);
  });
});

describe("overallFraction", () => {
  it("should add in-flight bytes to confirmed bytes", () => {
    expect(overallFraction(500, [100, 150], 1000)).toBe(0.75);
  });
  it("should clamp at 1 and handle an empty file", () => {
    expect(overallFraction(900, [200], 1000)).toBe(1);
    expect(overallFraction(0, [], 0)).toBe(0);
  });
});

describe("resumeStorageKey", () => {
  const base = { eventCode: "EVT-1", name: "m.mp4", size: 10, lastModified: 5 };
  it("should differ by target video, size, modification time and name", () => {
    const k = resumeStorageKey(base);
    expect(resumeStorageKey({ ...base, videoId: 3 })).not.toBe(k);
    expect(resumeStorageKey({ ...base, size: 11 })).not.toBe(k);
    expect(resumeStorageKey({ ...base, lastModified: 6 })).not.toBe(k);
    expect(resumeStorageKey({ ...base, name: "n.mp4" })).not.toBe(k);
  });
  it("should be stable for the same file and target", () => {
    expect(resumeStorageKey({ ...base, videoId: 3 })).toBe(resumeStorageKey({ ...base, videoId: 3 }));
  });
});

describe("parseResumeEntry", () => {
  const now = 1_000_000_000_000;
  const entry = { uploadId: "u", s3Key: "events/E/masters/1-a.mp4", partSize: 64, partCount: 3, createdAt: now - 1000 };
  const raw = (o: object) => JSON.stringify(o);

  it("should accept a fresh entry matching the file size", () => {
    expect(parseResumeEntry(raw(entry), now, 150)).toEqual(entry);
  });
  it("should return null for missing or corrupt data", () => {
    expect(parseResumeEntry(null, now, 150)).toBeNull();
    expect(parseResumeEntry("{nope", now, 150)).toBeNull();
    expect(parseResumeEntry("42", now, 150)).toBeNull();
    expect(parseResumeEntry(raw({ ...entry, uploadId: "" }), now, 150)).toBeNull();
    expect(parseResumeEntry(raw({ ...entry, partSize: "64" }), now, 150)).toBeNull();
  });
  it("should return null when older than 6 days", () => {
    expect(parseResumeEntry(raw({ ...entry, createdAt: now - RESUME_MAX_AGE_MS - 1 }), now, 150)).toBeNull();
    expect(parseResumeEntry(raw({ ...entry, createdAt: now - RESUME_MAX_AGE_MS + 1 }), now, 150)).not.toBeNull();
  });
  it("should return null when the part plan does not match the file size", () => {
    expect(parseResumeEntry(raw(entry), now, 1000)).toBeNull();
  });
});

describe("partsToSkip / bytesOfParts", () => {
  it("should skip only parts present with the exact expected size", () => {
    const listed = [
      { partNumber: 1, size: 64 },
      { partNumber: 2, size: 10 }, // truncated: re-upload
      { partNumber: 3, size: 22 }, // short last part is full-size for part 3
      { partNumber: 9, size: 64 }, // out of range
    ];
    expect(partsToSkip(listed, 64, 3, 150)).toEqual([1, 3]);
  });
  it("should sum the bytes of the skipped parts including the short last part", () => {
    expect(bytesOfParts([1, 3], 64, 150)).toBe(64 + 22);
  });
});
