import { describe, expect, it } from "vitest";
import { formatDayMonthYear, formatEventDates } from "./eventDates";

describe("formatEventDates", () => {
  it("should show one date when the event has no end", () => {
    expect(formatEventDates("2026-09-18", null)).toBe("18/09/2026");
  });

  it("should show one date when start and end are the same day", () => {
    expect(formatEventDates("2026-09-18", "2026-09-18")).toBe("18/09/2026");
  });

  it("should compact a range within one month", () => {
    expect(formatEventDates("2026-09-18", "2026-09-20")).toBe("18–20/09/2026");
  });

  it("should keep both months for a range across months", () => {
    expect(formatEventDates("2026-09-18", "2026-10-02")).toBe("18/09–02/10/2026");
  });

  it("should keep both years for a range across years", () => {
    expect(formatEventDates("2025-12-30", "2026-01-02")).toBe("30/12/2025–02/01/2026");
  });

  it("should read a full ISO timestamp by its date part", () => {
    expect(formatEventDates("2026-09-18T00:00:00.000Z", "2026-09-20T00:00:00.000Z")).toBe("18–20/09/2026");
  });

  it("should show a dash when there is no start date", () => {
    expect(formatEventDates(null, "2026-09-20")).toBe("—");
  });
});

describe("formatDayMonthYear", () => {
  it("should format a timestamp as dd/mm/yyyy", () => {
    expect(formatDayMonthYear(new Date(2026, 10, 3, 12).toISOString())).toBe("03/11/2026");
  });

  it("should show a dash when missing", () => {
    expect(formatDayMonthYear(null)).toBe("—");
  });
});
