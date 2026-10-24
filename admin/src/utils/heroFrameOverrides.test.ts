import { describe, it, expect } from "vitest";
import {
  overridesSurviveCrop,
  readHeroFrameOverrides,
  serializeHeroFrameOverrides,
} from "./heroFrameOverrides";
import { appendHeroEdit } from "./heroEdit";

const crop = { x: 10, y: 20, width: 1600, height: 900 };

describe("readHeroFrameOverrides", () => {
  it("should return nothing when the record has no overrides", () => {
    expect(readHeroFrameOverrides(null)).toEqual({});
    expect(readHeroFrameOverrides(undefined)).toEqual({});
  });

  it("should drop unknown frames and malformed entries and clamp the rest", () => {
    const out = readHeroFrameOverrides({
      page: { focalX: 120, focalY: 30, zoom: 9 },
      bogus: { focalX: 1, focalY: 1, zoom: 1 },
      home: { focalX: "x", focalY: 1, zoom: 1 },
    });
    expect(out).toEqual({ page: { focalX: 100, focalY: 30, zoom: 3 } });
  });
});

describe("overridesSurviveCrop", () => {
  it("should survive an unchanged crop, give or take rounding", () => {
    expect(overridesSurviveCrop(crop, { ...crop, x: 11 })).toBe(true);
  });

  it("should not survive a different crop", () => {
    expect(overridesSurviveCrop(crop, { ...crop, width: 1400 })).toBe(false);
  });
});

describe("appendHeroEdit", () => {
  it("should send the overrides as JSON when a frame has its own framing", () => {
    const form = new FormData();
    appendHeroEdit(form, { original: null, crop, grayscale: false, frameOverrides: { page: { focalX: 40.04, focalY: 60, zoom: 1.5 } } });
    expect(JSON.parse(form.get("frameOverrides") as string)).toEqual({ page: { focalX: 40, focalY: 60, zoom: 1.5 } });
  });

  it("should leave the field out when no frame is adjusted", () => {
    const form = new FormData();
    appendHeroEdit(form, { original: null, crop, grayscale: false, frameOverrides: {} });
    expect(form.has("frameOverrides")).toBe(false);
  });
});

describe("serializeHeroFrameOverrides", () => {
  it("should keep frame order stable", () => {
    const a = { zoom: 1, focalX: 1, focalY: 1 };
    expect(Object.keys(JSON.parse(serializeHeroFrameOverrides({ "desk-page": a, home: a })))).toEqual(["home", "desk-page"]);
  });
});
