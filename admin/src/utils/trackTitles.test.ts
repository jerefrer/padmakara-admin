import { describe, expect, it } from "vitest";
import { needsTitle } from "./trackTitles";

describe("needsTitle", () => {
  it("should not ask for an English title on a Portuguese translation track", () => {
    expect(needsTitle({ isTranslation: true, languages: ["pt"] }, "titleEn")).toBe(false);
  });

  it("should still ask for a Portuguese title on a Portuguese translation track", () => {
    expect(needsTitle({ isTranslation: true, languages: ["pt"] }, "titlePt")).toBe(true);
  });

  it("should ask for an English title on an original Portuguese track", () => {
    expect(needsTitle({ isTranslation: false, languages: ["pt"] }, "titleEn")).toBe(true);
  });

  it("should ask for an English title on a translation that also speaks English", () => {
    expect(needsTitle({ isTranslation: true, languages: ["pt", "en"] }, "titleEn")).toBe(true);
  });

  it("should ask for both titles when the track's languages are unknown", () => {
    expect(needsTitle({}, "titleEn")).toBe(true);
  });
});
