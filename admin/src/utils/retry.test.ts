import { describe, it, expect, vi } from "vitest";
import {
  HttpStatusError,
  NetworkError,
  UploadCancelledError,
  backoffDelay,
  isTransientError,
  withRetry,
} from "./retry";

const noSleep = () => Promise.resolve();

describe("isTransientError", () => {
  it("should treat dropped connections, timeouts, throttling and 5xx as transient", () => {
    expect(isTransientError(new NetworkError("offline"))).toBe(true);
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new HttpStatusError("x", 0))).toBe(true);
    expect(isTransientError(new HttpStatusError("x", 408))).toBe(true);
    expect(isTransientError(new HttpStatusError("x", 429))).toBe(true);
    expect(isTransientError(new HttpStatusError("x", 503))).toBe(true);
  });

  it("should treat client errors, cancellation and unknown errors as permanent", () => {
    expect(isTransientError(new HttpStatusError("x", 403))).toBe(false);
    expect(isTransientError(new HttpStatusError("x", 400))).toBe(false);
    expect(isTransientError(new UploadCancelledError())).toBe(false);
    expect(isTransientError(new Error("boom"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("should double the delay on each retry up to the cap", () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, 1000, 5000))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });
});

describe("withRetry", () => {
  it("should return the result when the first attempt succeeds", async () => {
    const fn = vi.fn(() => Promise.resolve("ok"));

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry a transient error with growing delays until it succeeds", async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockRejectedValueOnce(new HttpStatusError("busy", 503))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { sleep, baseDelayMs: 100 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("should give up after the configured number of retries", async () => {
    const fn = vi.fn(() => Promise.reject(new NetworkError("offline")));

    await expect(withRetry(fn, { sleep: noSleep, retries: 2 })).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry a permanent error", async () => {
    const fn = vi.fn(() => Promise.reject(new HttpStatusError("forbidden", 403)));

    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should stop retrying once the upload is cancelled", async () => {
    const signal = { cancelled: false };
    const fn = vi.fn(() => {
      signal.cancelled = true;
      return Promise.reject(new NetworkError("offline"));
    });

    await expect(withRetry(fn, { sleep: noSleep, signal })).rejects.toBeInstanceOf(
      UploadCancelledError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should report each retry before waiting", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, { sleep: noSleep, onRetry, baseDelayMs: 50 });

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(NetworkError), 50);
  });
});
