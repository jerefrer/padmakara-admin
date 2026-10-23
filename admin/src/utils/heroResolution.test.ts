import { describe, it, expect } from "vitest";
import { heroResolutionAdvice } from "./heroResolution";

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
