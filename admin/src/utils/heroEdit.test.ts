import { describe, expect, it } from "vitest";
import { storedHeroEdit } from "./heroEdit";

const OVERRIDES = { home: { focalX: 20, focalY: 30, zoom: 1.5 } };
const CROP = { x: 500, y: 300, width: 1600, height: 900 };

describe("storedHeroEdit", () => {
  it("should restore the crop, black-and-white and overrides of a hero with a kept original", () => {
    const edit = storedHeroEdit({
      heroOriginalS3Key: "teachers/heroes/7-original.jpg",
      heroCrop: CROP,
      heroGrayscale: true,
      heroFrameOverrides: OVERRIDES,
    });
    expect(edit).toEqual({ storedOriginal: true, initialCrop: CROP, initialGrayscale: true, initialFrameOverrides: OVERRIDES });
  });

  it("should pass the saved overrides of a hero saved before originals were kept", () => {
    const edit = storedHeroEdit({ heroOriginalS3Key: null, heroFrameOverrides: OVERRIDES });
    expect(edit).toEqual({ storedOriginal: false, initialFrameOverrides: OVERRIDES });
  });

  it("should pass no overrides when a hero without original has none", () => {
    expect(storedHeroEdit({ heroOriginalS3Key: null, heroFrameOverrides: null })).toEqual({ storedOriginal: false });
  });
});
