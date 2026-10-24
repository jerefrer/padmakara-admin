import { describe, it, expect } from "vitest";
import { focalAfterPan, focalCoverPosition } from "../../admin/src/utils/focalCover.ts";

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

// Shared cases: padmakara-app/__tests__/utils/focalCover.test.ts carries the same table and checks
// the app's placement against it, so the admin previews and the app cannot drift apart.
const ZOOM_CASES: Array<{
  name: string;
  input: [number, number, number, number, number, number, number];
  expected: { w: number; h: number; ox: number; oy: number };
}> = [
  {
    name: "zoom 1 keeps the plain cover fit",
    input: [390, 260, 1200, 1800, 50, 25, 1],
    expected: { w: 390, h: 585, ox: 0, oy: -16.25 },
  },
  {
    name: "zoom 2 doubles the cover size and centres on the focal point",
    input: [390, 260, 1200, 1800, 50, 25, 2],
    expected: { w: 780, h: 1170, ox: -195, oy: -162.5 },
  },
  {
    name: "zoom 1.5 on a landscape image centres on an off-centre focal point",
    input: [390, 380, 2400, 1350, 30, 50, 1.5],
    expected: { w: 1013.33, h: 570, ox: -109, oy: -95 },
  },
  {
    name: "zoom 3 at the bottom-right corner is clamped so the frame stays covered",
    input: [400, 280, 1000, 1000, 100, 100, 3],
    expected: { w: 1200, h: 1200, ox: -800, oy: -920 },
  },
  {
    name: "zoom above 3 is treated as 3",
    input: [400, 280, 1000, 1000, 100, 100, 5],
    expected: { w: 1200, h: 1200, ox: -800, oy: -920 },
  },
];

describe("focalCoverPosition with per-frame zoom", () => {
  it.each(ZOOM_CASES)("should match the shared table when $name", ({ input, expected }) => {
    const [fw, fh, iw, ih, fx, fy, zoom] = input;
    const r = focalCoverPosition({
      frameWidth: fw,
      frameHeight: fh,
      imageWidth: iw,
      imageHeight: ih,
      focalX: fx,
      focalY: fy,
      zoom,
    });
    expect({ w: r2(r.width), h: r2(r.height), ox: r2(r.offsetX), oy: r2(r.offsetY) }).toEqual(expected);
  });
});

describe("focalAfterPan", () => {
  const base = { frameWidth: 390, frameHeight: 380, imageWidth: 2400, imageHeight: 1350, focalX: 50, focalY: 50, zoom: 1 };

  it("should move the focal point opposite to the drag when the image has horizontal slack", () => {
    // width 675.56: dragging the image 100 right shifts the focal point left by 100 / 675.56
    const { focalX } = focalAfterPan(base, 100, 0);
    expect(focalX).toBeCloseTo(50 - (100 / 675.5556) * 100, 1);
  });

  it("should keep the focal value of an axis without slack", () => {
    expect(focalAfterPan(base, 0, 80).focalY).toBe(50);
  });

  it("should clamp the focal point to 0..100", () => {
    expect(focalAfterPan(base, 5000, 0).focalX).toBe(0);
    expect(focalAfterPan(base, -5000, 0).focalX).toBe(100);
  });

  it("should not jump when the shown placement is clamped", () => {
    // focal 0 is clamped at the left edge: a zero drag must leave the placement unchanged
    const start = { ...base, focalX: 0 };
    const { focalX } = focalAfterPan(start, 0, 0);
    expect(focalCoverPosition({ ...start, focalX }).offsetX).toBe(focalCoverPosition(start).offsetX);
  });
});
