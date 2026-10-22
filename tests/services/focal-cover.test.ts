import { describe, it, expect } from "vitest";
import { focalCoverPosition } from "../../admin/src/utils/focalCover.ts";

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const run = (fw: number, fh: number, iw: number, ih: number, fx: number, fy: number) => {
  const r = focalCoverPosition({
    frameWidth: fw,
    frameHeight: fh,
    imageWidth: iw,
    imageHeight: ih,
    focalX: fx,
    focalY: fy,
  });
  return { w: r2(r.width), h: r2(r.height), ox: r2(r.offsetX), oy: r2(r.offsetY) };
};

describe("focalCoverPosition", () => {
  it("should shift a portrait image up by 24.25 when frame is 390x244 and focal is (50,25)", () => {
    // s = 0.325 -> 390x585; oy = 122 - 0.25*585 = -24.25
    expect(run(390, 244, 1200, 1800, 50, 25)).toEqual({ w: 390, h: 585, ox: 0, oy: -24.25 });
  });

  it("should shift a landscape image left by 7.67 when frame is 390x380 and focal is (30,50)", () => {
    // s = 380/1350 -> 675.56x380; ox = 195 - 0.3*675.56 = -7.67
    expect(run(390, 380, 2400, 1350, 30, 50)).toEqual({ w: 675.56, h: 380, ox: -7.67, oy: 0 });
  });

  it("should clamp to the bottom edge when frame is 900x380 and focal is (50,90)", () => {
    // s = 0.375 -> 900x506.25; oy = 190 - 455.625 = -265.625, clamped to 380 - 506.25
    expect(run(900, 380, 2400, 1350, 50, 90)).toEqual({ w: 900, h: 506.25, ox: 0, oy: -126.25 });
  });

  it("should centre the focal point when the image has slack on both sides", () => {
    expect(run(100, 100, 400, 200, 50, 50)).toEqual({ w: 200, h: 100, ox: -50, oy: 0 });
  });

  it("should clamp to the left edge when the focal point is at 0%", () => {
    expect(run(100, 100, 400, 200, 0, 50).ox).toBe(0);
  });

  it("should clamp to the right edge when the focal point is at 100%", () => {
    expect(run(100, 100, 400, 200, 100, 50).ox).toBe(-100);
  });

  it("should not move the image when the aspect ratio matches the frame", () => {
    expect(run(160, 90, 1600, 900, 20, 80)).toEqual({ w: 160, h: 90, ox: 0, oy: 0 });
  });

  it("should return a zero offset when sizes are invalid", () => {
    expect(run(100, 100, 0, 200, 30, 30)).toEqual({ w: 100, h: 100, ox: 0, oy: 0 });
  });
});
