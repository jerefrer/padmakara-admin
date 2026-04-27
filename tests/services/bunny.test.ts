import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  signBunnyPath,
  buildPlaybackUrls,
  buildTusCredentials,
  buildMp4DownloadUrl,
  getVideoMeta,
  createVideo,
  deleteVideo,
  parseAvailableResolutions,
  bestAvailableResolution,
} from "../../src/services/bunny.ts";

// Compute the expected token the same way the service does, so tests verify the
// algorithm is correct rather than just snapshotting a value we made up.
function expectedToken(securityKey: string, path: string, expires: number): string {
  return createHash("sha256")
    .update(securityKey + path + expires)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("bunny service", () => {
  describe("signBunnyPath", () => {
    it("produces a URL-safe base64 SHA-256 token", () => {
      const expires = 1700000000;
      const token = signBunnyPath("/abc/playlist.m3u8", expires);
      expect(token).toBe(expectedToken("test-token-auth-key", "/abc/playlist.m3u8", expires));
    });

    it("produces different tokens for different paths", () => {
      const expires = 1700000000;
      const a = signBunnyPath("/video-a/playlist.m3u8", expires);
      const b = signBunnyPath("/video-b/playlist.m3u8", expires);
      expect(a).not.toBe(b);
    });

    it("produces different tokens for different expirations", () => {
      const path = "/abc/playlist.m3u8";
      expect(signBunnyPath(path, 1700000000)).not.toBe(signBunnyPath(path, 1700000001));
    });

    it("rejects paths that don't start with /", () => {
      expect(() => signBunnyPath("abc/playlist.m3u8", 1700000000)).toThrow(/must start with/);
    });

    it("token is URL-safe (no +, /, or = characters)", () => {
      const token = signBunnyPath("/abc/playlist.m3u8", 1700000000);
      expect(token).not.toMatch(/[+/=]/);
    });
  });

  describe("buildPlaybackUrls", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns HLS, iframe, thumbnail URLs and expiry", () => {
      const urls = buildPlaybackUrls("video-guid-123");
      expect(urls.hls).toMatch(/^https:\/\/vz-test\.b-cdn\.net\/video-guid-123\/playlist\.m3u8\?token=.+&expires=\d+$/);
      expect(urls.iframe).toMatch(/^https:\/\/iframe\.mediadelivery\.net\/embed\/12345\/video-guid-123\?token=.+&expires=\d+$/);
      expect(urls.thumbnail).toMatch(/^https:\/\/vz-test\.b-cdn\.net\/video-guid-123\/thumbnail\.jpg\?token=.+&expires=\d+$/);
      expect(urls.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("respects the configured TTL by default", () => {
      const urls = buildPlaybackUrls("video-guid-123");
      const now = Math.floor(Date.now() / 1000);
      expect(urls.expiresAt).toBe(now + 3600);
    });

    it("accepts a custom TTL", () => {
      const urls = buildPlaybackUrls("video-guid-123", 600);
      const now = Math.floor(Date.now() / 1000);
      expect(urls.expiresAt).toBe(now + 600);
    });

    it("HLS token is signed against the HLS path", () => {
      const urls = buildPlaybackUrls("video-guid-123", 600);
      const token = new URL(urls.hls).searchParams.get("token");
      expect(token).toBe(expectedToken("test-token-auth-key", "/video-guid-123/playlist.m3u8", urls.expiresAt));
    });

    it("thumbnail token is signed against the thumbnail path (different from HLS)", () => {
      const urls = buildPlaybackUrls("video-guid-123", 600);
      const hlsToken = new URL(urls.hls).searchParams.get("token");
      const thumbToken = new URL(urls.thumbnail).searchParams.get("token");
      expect(thumbToken).not.toBe(hlsToken);
      expect(thumbToken).toBe(expectedToken("test-token-auth-key", "/video-guid-123/thumbnail.jpg", urls.expiresAt));
    });

    it("rejects empty videoId", () => {
      expect(() => buildPlaybackUrls("")).toThrow(/videoId/);
    });
  });

  describe("buildTusCredentials", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns endpoint, videoId, libraryId, signature, expirationTime", () => {
      const creds = buildTusCredentials("vid-guid-123");
      expect(creds.endpoint).toBe("https://video.bunnycdn.com/tusupload");
      expect(creds.videoId).toBe("vid-guid-123");
      expect(creds.libraryId).toBe("12345");
      expect(creds.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(creds.expirationTime).toBe(Math.floor(Date.now() / 1000) + 3600);
    });

    it("signature is hex sha256(libraryId + apiKey + expirationTime + videoId)", () => {
      const creds = buildTusCredentials("vid-guid-123");
      const expected = createHash("sha256")
        .update("12345" + "test-api-key" + creds.expirationTime + "vid-guid-123")
        .digest("hex");
      expect(creds.signature).toBe(expected);
    });

    it("respects custom TTL", () => {
      const creds = buildTusCredentials("vid-guid-123", 600);
      expect(creds.expirationTime).toBe(Math.floor(Date.now() / 1000) + 600);
    });

    it("rejects empty videoId", () => {
      expect(() => buildTusCredentials("")).toThrow(/videoId/);
    });
  });

  describe("buildMp4DownloadUrl", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults to 720p with a 3-hour TTL", () => {
      const result = buildMp4DownloadUrl("vid-123");
      const now = Math.floor(Date.now() / 1000);
      expect(result.expiresAt).toBe(now + 3 * 60 * 60);
      expect(result.url).toContain("/vid-123/play_720p.mp4");
      expect(result.url).toMatch(/[?&]token=/);
      expect(result.url).toMatch(/[?&]expires=\d+/);
    });

    it("supports each documented quality ladder", () => {
      const qualities = ["240p", "360p", "480p", "720p", "1080p"] as const;
      for (const q of qualities) {
        const result = buildMp4DownloadUrl("vid-123", q);
        expect(result.url).toContain(`/vid-123/play_${q}.mp4`);
      }
    });

    it("rejects empty videoId", () => {
      expect(() => buildMp4DownloadUrl("")).toThrow(/videoId/);
    });

    it("token is signed against the MP4 path (different from HLS)", () => {
      const mp4 = buildMp4DownloadUrl("vid-123", "720p", 600);
      const mp4Token = new URL(mp4.url).searchParams.get("token");
      const hls = buildPlaybackUrls("vid-123", 600);
      const hlsToken = new URL(hls.hls).searchParams.get("token");
      expect(mp4Token).not.toBe(hlsToken);
      expect(mp4Token).toBe(expectedToken("test-token-auth-key", "/vid-123/play_720p.mp4", mp4.expiresAt));
    });
  });

  describe("parseAvailableResolutions", () => {
    it("parses Bunny's comma-separated list", () => {
      expect(parseAvailableResolutions("240p,360p,480p,720p,1080p")).toEqual([
        "240p", "360p", "480p", "720p", "1080p",
      ]);
    });

    it("trims whitespace", () => {
      expect(parseAvailableResolutions("240p, 360p ,480p")).toEqual(["240p", "360p", "480p"]);
    });

    it("returns empty array for null/undefined/empty", () => {
      expect(parseAvailableResolutions(null)).toEqual([]);
      expect(parseAvailableResolutions(undefined)).toEqual([]);
      expect(parseAvailableResolutions("")).toEqual([]);
    });

    it("ignores unknown resolution tokens", () => {
      expect(parseAvailableResolutions("720p,foo,1080p,4k")).toEqual(["720p", "1080p"]);
    });
  });

  describe("bestAvailableResolution", () => {
    it("returns the highest variant <= requested when an exact match exists", () => {
      expect(bestAvailableResolution("720p", ["240p", "360p", "480p", "720p", "1080p"])).toBe("720p");
    });

    it("falls back to the next-lower variant when requested isn't available", () => {
      expect(bestAvailableResolution("720p", ["240p", "360p", "480p"])).toBe("480p");
    });

    it("never upgrades above the requested resolution", () => {
      expect(bestAvailableResolution("480p", ["720p", "1080p"])).toBe(null);
      expect(bestAvailableResolution("480p", ["240p", "720p"])).toBe("240p");
    });

    it("returns null when no variants are available", () => {
      expect(bestAvailableResolution("720p", [])).toBe(null);
    });

    it("returns the highest available even if requested is higher", () => {
      expect(bestAvailableResolution("1080p", ["360p", "480p"])).toBe("480p");
    });

    it("handles unordered input", () => {
      expect(bestAvailableResolution("720p", ["1080p", "240p", "480p"])).toBe("480p");
    });
  });

  describe("Bunny API calls", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn() as any;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("getVideoMeta calls the correct URL with AccessKey header", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          guid: "abc",
          title: "Test",
          status: 4,
          length: 600,
          width: 1920,
          height: 1080,
          framerate: 30,
          thumbnailFileName: "thumbnail.jpg",
          availableResolutions: "240p,360p,480p,720p,1080p",
        }),
      });

      const meta = await getVideoMeta("abc");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://video.bunnycdn.com/library/12345/videos/abc",
        expect.objectContaining({
          headers: expect.objectContaining({ AccessKey: "test-api-key" }),
        }),
      );
      expect(meta.guid).toBe("abc");
      expect(meta.length).toBe(600);
      expect(meta.availableResolutions).toBe("240p,360p,480p,720p,1080p");
    });

    it("getVideoMeta surfaces API errors", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });

      await expect(getVideoMeta("missing")).rejects.toThrow(/Bunny API 404/);
    });

    it("createVideo POSTs the title and returns the GUID", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ guid: "new-guid" }),
      });

      const result = await createVideo("Morning Session 1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://video.bunnycdn.com/library/12345/videos",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ title: "Morning Session 1" }),
        }),
      );
      expect(result.guid).toBe("new-guid");
    });

    it("deleteVideo treats 404 as success (already gone)", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });
      await expect(deleteVideo("missing")).resolves.toBeUndefined();
    });

    it("deleteVideo throws on non-404 errors", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Server Error",
      });
      await expect(deleteVideo("abc")).rejects.toThrow(/Bunny API 500/);
    });
  });
});
