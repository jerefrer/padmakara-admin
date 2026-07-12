import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchVideo } from "../../src/services/bunny.ts";

describe("fetchVideo (pull from URL)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the url and title to the /videos/fetch endpoint with the AccessKey header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ guid: "fetched-guid" }),
    });

    const result = await fetchVideo("https://x/y.mpg", "T");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://video.bunnycdn.com/library/12345/videos/fetch",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ AccessKey: "test-api-key" }),
        body: JSON.stringify({ url: "https://x/y.mpg", title: "T" }),
      }),
    );
    expect(result.guid).toBe("fetched-guid");
  });

  it("accepts an `id` field as a fallback for the guid", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "fallback-id" }),
    });

    const result = await fetchVideo("https://x/y.mpg", "T");
    expect(result.guid).toBe("fallback-id");
  });

  it("throws when the response has no guid or id", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: "queued" }),
    });

    await expect(fetchVideo("https://x/y.mpg", "T")).rejects.toThrow(/no guid/);
  });

  it("throws on a non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Server Error",
    });

    await expect(fetchVideo("https://x/y.mpg", "T")).rejects.toThrow(/Bunny fetch 500/);
  });
});
