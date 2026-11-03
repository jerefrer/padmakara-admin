import { describe, it, expect } from "vitest";
import { artworkFraming, computeSquareCrop, teacherArtworkUrl } from "../../src/lib/teacher-artwork.ts";

describe("computeSquareCrop", () => {
  it("should centre the square on a centred focal point", () => {
    expect(computeSquareCrop({ width: 2400, height: 1600, focalX: 50, focalY: 50 })).toEqual({
      left: 400,
      top: 0,
      size: 1600,
    });
  });

  it("should clamp inside the image when the focal point is at the top-left corner", () => {
    expect(computeSquareCrop({ width: 2400, height: 1600, focalX: 0, focalY: 0 })).toEqual({
      left: 0,
      top: 0,
      size: 1600,
    });
  });

  it("should clamp inside the image when the focal point is at the bottom-right corner", () => {
    expect(computeSquareCrop({ width: 2400, height: 1600, focalX: 100, focalY: 100 })).toEqual({
      left: 800,
      top: 0,
      size: 1600,
    });
  });

  it("should follow the focal point on the free axis of a portrait image", () => {
    const crop = computeSquareCrop({ width: 1000, height: 2000, focalX: 50, focalY: 25 });
    expect(crop).toEqual({ left: 0, top: 0, size: 1000 });
    expect(computeSquareCrop({ width: 1000, height: 2000, focalX: 50, focalY: 60 }).top).toBe(700);
  });

  it("should shrink the square by the zoom and keep it inside the image", () => {
    const crop = computeSquareCrop({ width: 2400, height: 1600, focalX: 100, focalY: 0, zoom: 2 });
    expect(crop).toEqual({ left: 1600, top: 0, size: 800 });
  });

  it("should ignore focal values outside 0..100 and zoom outside 1..3", () => {
    const crop = computeSquareCrop({ width: 2000, height: 1000, focalX: 250, focalY: -40, zoom: 9 });
    expect(crop.size).toBe(333);
    expect(crop.left + crop.size).toBeLessThanOrEqual(2000);
    expect(crop.top).toBe(0);
  });
});

describe("artworkFraming", () => {
  it("should use the page layout's own framing when set", () => {
    const framing = artworkFraming({
      heroFocalX: 50,
      heroFocalY: 50,
      heroFrameOverrides: { page: { focalX: 20, focalY: 30, zoom: 1.5 }, home: { focalX: 1, focalY: 1, zoom: 1 } },
    });
    expect(framing).toEqual({ focalX: 20, focalY: 30, zoom: 1.5 });
  });

  it("should fall back to the hero focal point without a page override", () => {
    expect(artworkFraming({ heroFocalX: 30, heroFocalY: 40, heroFrameOverrides: null })).toEqual({
      focalX: 30,
      focalY: 40,
      zoom: 1,
    });
  });
});

describe("teacherArtworkUrl", () => {
  const base = { id: 7, heroFocalX: 50, heroFocalY: 50, updatedAt: new Date("2026-01-02T00:00:00Z") };

  it("should return an absolute versioned URL when the teacher has a hero", () => {
    const url = teacherArtworkUrl({ ...base, heroS3Key: "teachers/x/hero.jpg" });
    expect(url).toMatch(/^https?:\/\/.+\/api\/teachers\/7\/artwork\.jpg\?v=1767312000000$/);
  });

  it("should return null when the teacher has no hero", () => {
    expect(teacherArtworkUrl({ ...base, heroS3Key: null })).toBeNull();
  });

  it("should return null for a missing teacher", () => {
    expect(teacherArtworkUrl(null)).toBeNull();
  });
});
