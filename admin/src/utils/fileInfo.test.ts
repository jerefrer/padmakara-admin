import { describe, expect, it } from "vitest";
import {
  formatBitrate,
  formatBytes,
  formatDurationHms,
  formatFrameRate,
  formatResolution,
  formatSampleRate,
} from "./fileInfo";

describe("formatBytes", () => {
  it("should format megabytes with one decimal", () => {
    expect(formatBytes(12_345_678)).toBe("11.8 MB");
  });
  it("should switch to gigabytes with two decimals", () => {
    expect(formatBytes(9_000_000_000)).toBe("8.38 GB");
  });
  it("should show small files in KB and tiny ones in bytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(512)).toBe("512 B");
  });
  it("should return null when the size is unknown", () => {
    expect(formatBytes(null)).toBeNull();
  });
});

describe("formatDurationHms", () => {
  it("should format as h:mm:ss", () => {
    expect(formatDurationHms(3725)).toBe("1:02:05");
    expect(formatDurationHms(65)).toBe("0:01:05");
  });
  it("should return null for unknown or zero durations", () => {
    expect(formatDurationHms(null)).toBeNull();
    expect(formatDurationHms(0)).toBeNull();
  });
});

describe("formatBitrate", () => {
  it("should append kbps", () => {
    expect(formatBitrate(128)).toBe("128 kbps");
    expect(formatBitrate(null)).toBeNull();
  });
});

describe("formatSampleRate", () => {
  it("should show kHz and drop a trailing .0", () => {
    expect(formatSampleRate(44100)).toBe("44.1 kHz");
    expect(formatSampleRate(48000)).toBe("48 kHz");
    expect(formatSampleRate(null)).toBeNull();
  });
});

describe("formatResolution", () => {
  it("should join width and height with a times sign", () => {
    expect(formatResolution(1920, 1080)).toBe("1920 × 1080");
  });
  it("should return null when either side is unknown", () => {
    expect(formatResolution(1920, null)).toBeNull();
    expect(formatResolution(null, null)).toBeNull();
  });
});

describe("formatFrameRate", () => {
  it("should trim to at most two decimals", () => {
    expect(formatFrameRate(25)).toBe("25 fps");
    expect(formatFrameRate(29.97002997)).toBe("29.97 fps");
    expect(formatFrameRate(null)).toBeNull();
  });
});
