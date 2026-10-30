import { describe, it, expect } from "vitest";
import {
  PART_RETRY_DELAYS_MS,
  decidePartRetry,
  nextPresignBatch,
  overallFraction,
  partRange,
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
