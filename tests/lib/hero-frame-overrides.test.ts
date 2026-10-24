import { describe, it, expect } from "vitest";
import { heroFrameOverridesSchema, parseHeroFrameOverridesField } from "../../src/lib/schemas.ts";
import { HERO_FRAME_KEYS } from "../../src/db/schema/teachers.ts";

const frame = { focalX: 50, focalY: 50, zoom: 1 };

describe("heroFrameOverridesSchema", () => {
  it("should accept every known frame key", () => {
    const all = Object.fromEntries(HERO_FRAME_KEYS.map((k) => [k, frame]));
    expect(heroFrameOverridesSchema.safeParse(all).success).toBe(true);
  });

  it("should list exactly the frames the admin previews", () => {
    expect([...HERO_FRAME_KEYS]).toEqual(["home", "home-short", "page", "desk-home", "desk-page"]);
  });

  it("should reject an unknown frame key", () => {
    expect(heroFrameOverridesSchema.safeParse({ phone: frame }).success).toBe(false);
  });

  it.each([
    ["focalX below 0", { ...frame, focalX: -1 }],
    ["focalY above 100", { ...frame, focalY: 100.5 }],
    ["zoom below 1", { ...frame, zoom: 0.9 }],
    ["zoom above 3", { ...frame, zoom: 3.01 }],
    ["a missing zoom", { focalX: 1, focalY: 1 }],
  ])("should reject %s", (_name, value) => {
    expect(heroFrameOverridesSchema.safeParse({ page: value }).success).toBe(false);
  });

  it("should accept the boundary values", () => {
    expect(heroFrameOverridesSchema.safeParse({ page: { focalX: 0, focalY: 100, zoom: 3 } }).success).toBe(true);
  });
});

describe("parseHeroFrameOverridesField", () => {
  it("should return null when the field is missing or empty", () => {
    expect(parseHeroFrameOverridesField(null)).toBeNull();
    expect(parseHeroFrameOverridesField("")).toBeNull();
    expect(parseHeroFrameOverridesField("{}")).toBeNull();
  });

  it("should return the parsed overrides", () => {
    expect(parseHeroFrameOverridesField(JSON.stringify({ page: frame }))).toEqual({ page: frame });
  });

  it("should throw on malformed JSON", () => {
    expect(() => parseHeroFrameOverridesField("{")).toThrow();
  });
});
