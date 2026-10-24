import { describe, it, expect } from "vitest";
import { heroFrameResolutionAdvice, heroResolutionAdvice } from "./heroResolution";

describe("heroResolutionAdvice", () => {
  it("should be good when the crop is at least as wide as the desktop hero", () => {
    expect(heroResolutionAdvice(2400).level).toBe("good");
    expect(heroResolutionAdvice(3600).level).toBe("good");
  });

  it("should be fair when the crop covers phones but not large screens", () => {
    expect(heroResolutionAdvice(1200).level).toBe("fair");
    expect(heroResolutionAdvice(2399).level).toBe("fair");
  });

  it("should be poor when the crop is narrower than the mobile hero", () => {
    expect(heroResolutionAdvice(1199).level).toBe("poor");
  });

  it("should round the width it reports", () => {
    expect(heroResolutionAdvice(2400.4).message).toMatch(/^2400 px wide/);
  });
});

describe("heroFrameResolutionAdvice", () => {
  it("should not flag a frame at zoom 1", () => {
    expect(heroFrameResolutionAdvice(2400, 1).degraded).toBe(false);
  });

  it("should flag a frame whose zoom drops the level", () => {
    const advice = heroFrameResolutionAdvice(2400, 3);
    expect(advice.level).toBe("poor");
    expect(advice.degraded).toBe(true);
  });

  it("should not flag a crop that was already small at zoom 1", () => {
    expect(heroFrameResolutionAdvice(1000, 1).degraded).toBe(false);
  });

  it("should report the width the frame actually shows", () => {
    expect(heroFrameResolutionAdvice(3000, 2).message).toMatch(/^1500 px wide/);
  });
});
