import { describe, expect, it } from "vitest";
import { chooseVideoEngine } from "./hlsEngine";

describe("chooseVideoEngine", () => {
  it("prefers hls.js even when the browser also claims native HLS support", () => {
    // The Chromium 'maybe' bug: canPlayType('…mpegurl') is truthy but a raw
    // .m3u8 on video.src fails with MediaError code 4. hls.js must win.
    expect(chooseVideoEngine({ hlsjsSupported: true, nativeHls: true })).toBe(
      "hlsjs",
    );
  });

  it("uses hls.js when only hls.js is available", () => {
    expect(chooseVideoEngine({ hlsjsSupported: true, nativeHls: false })).toBe(
      "hlsjs",
    );
  });

  it("falls back to native HLS only when hls.js cannot run (Safari/iOS)", () => {
    expect(chooseVideoEngine({ hlsjsSupported: false, nativeHls: true })).toBe(
      "native",
    );
  });

  it("falls back to a direct src when neither engine is available", () => {
    expect(chooseVideoEngine({ hlsjsSupported: false, nativeHls: false })).toBe(
      "direct",
    );
  });
});
