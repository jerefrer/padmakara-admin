import { describe, it, expect } from "vitest";
import { parseHeroCrop, heroOriginalExtension } from "../../src/lib/hero-original.ts";

describe("parseHeroCrop", () => {
  it("should return the rectangle when the field holds four numbers", () => {
    const crop = parseHeroCrop('{"x":10,"y":20.5,"width":1600,"height":900}');

    expect(crop).toEqual({ x: 10, y: 20.5, width: 1600, height: 900 });
  });

  it("should return null when the field is absent", () => {
    expect(parseHeroCrop(null)).toBeNull();
  });

  it("should throw a 400 when the field is not valid JSON", () => {
    expect(() => parseHeroCrop("{x:1")).toThrow(/crop/i);
  });

  it("should throw a 400 when a size is not positive", () => {
    expect(() => parseHeroCrop('{"x":0,"y":0,"width":0,"height":900}')).toThrow(/crop/i);
  });
});

describe("heroOriginalExtension", () => {
  it("should follow the uploaded image type", () => {
    expect(heroOriginalExtension("image/png", "photo.png")).toBe("png");
    expect(heroOriginalExtension("image/jpeg", "photo.jpeg")).toBe("jpg");
  });

  it("should fall back to the file name when the type is unknown", () => {
    expect(heroOriginalExtension("", "scan.TIFF")).toBe("tiff");
  });
});
