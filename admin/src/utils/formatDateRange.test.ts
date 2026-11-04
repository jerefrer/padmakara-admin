import { describe, expect, it } from "vitest";
import { formatDateRange } from "./formatDateRange";

describe("formatDateRange", () => {
  it("should collapse a range inside one month", () => {
    expect(formatDateRange("2026-10-10", "2026-10-11", "en")).toBe("10–11 Oct 2026");
  });

  it("should show a single day when there is no end date", () => {
    expect(formatDateRange("2026-10-10", null, "en")).toBe("10 Oct 2026");
  });

  it("should span months", () => {
    expect(formatDateRange("2026-10-30", "2026-11-02", "en")).toBe("30 Oct – 2 Nov 2026");
  });

  it("should return an empty string without a valid start", () => {
    expect(formatDateRange("", "2026-10-11", "en")).toBe("");
  });
});
