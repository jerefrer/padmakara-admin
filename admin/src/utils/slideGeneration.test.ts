import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_SLIDE_INPUTS,
  SlideGenerationError,
  nothingToGenerateFrom,
  requestDefaultSlides,
} from "./slideGeneration";

const authFetch = vi.fn();
vi.mock("./authFetch", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

const DOC = { version: 1, intro: [], outro: [] };

afterEach(() => {
  vi.useRealTimers();
  authFetch.mockReset();
});

describe("requestDefaultSlides", () => {
  it("returns the document, the missing list and the language", async () => {
    authFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ slides: DOC, missing: ["place"], language: "pt" }),
    });

    const result = await requestDefaultSlides("/api/x", { lang: "pt" });

    expect(result).toEqual({ slides: DOC, missing: ["place"], language: "pt" });
    expect(JSON.parse(authFetch.mock.calls[0]?.[1].body)).toEqual({ lang: "pt" });
  });

  it("treats an answer without a missing list as nothing missing", async () => {
    authFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ slides: DOC }) });
    const result = await requestDefaultSlides("/api/x", { lang: "en" });
    expect(result.missing).toEqual([]);
    expect(result.language).toBe("en");
  });

  it("throws an http error for a failing status", async () => {
    authFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(requestDefaultSlides("/api/x", { lang: "en" })).rejects.toMatchObject({
      kind: "http",
      message: "HTTP 500",
    });
  });

  it("throws a network error when the request fails", async () => {
    authFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestDefaultSlides("/api/x", { lang: "en" })).rejects.toMatchObject({ kind: "network" });
  });

  it("aborts and throws a timeout error when the server never answers", async () => {
    vi.useFakeTimers();
    authFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );

    const pending = requestDefaultSlides("/api/x", { lang: "en" }, 30_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(SlideGenerationError);
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("nothingToGenerateFrom", () => {
  it("is true only when every input is missing", () => {
    expect(nothingToGenerateFrom(ALL_SLIDE_INPUTS)).toBe(true);
    expect(nothingToGenerateFrom(ALL_SLIDE_INPUTS.filter((k) => k !== "title"))).toBe(false);
    expect(nothingToGenerateFrom([])).toBe(false);
  });
});
