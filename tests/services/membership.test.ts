import { describe, it, expect } from "vitest";
import {
  parseContribution, frequencyFor, intervalFromFrequency, addInterval, nextExpiry, easypayDateTime,
} from "../../src/services/membership.ts";

describe("parseContribution", () => {
  it("should accept the monthly floor", () => {
    expect(parseContribution(5, "month")).toEqual({ ok: true, amount: 5, interval: "month" });
  });
  it("should accept a yearly amount of 60", () => {
    expect(parseContribution(60, "year")).toEqual({ ok: true, amount: 60, interval: "year" });
  });
  it("should accept a numeric string with two decimals", () => {
    expect(parseContribution("12.50", "month")).toEqual({ ok: true, amount: 12.5, interval: "month" });
  });
  it.each([[19.99], [5.1], [16.35], [1.15 * 10]])("should accept the two-decimal amount %s", (amount) => {
    expect(parseContribution(amount, "month").ok).toBe(true);
  });
  it.each([
    [4.99, "month"], [59, "year"], [1000.01, "month"], [5.555, "month"], [12.555, "month"],
    ["abc", "month"], [null, "month"], [NaN, "month"], [Infinity, "year"], [-5, "month"],
  ])("should reject amount %s for %s", (amount, interval) => {
    expect(parseContribution(amount, interval).ok).toBe(false);
  });
  it("should return the amount rounded to cents when a sub-cent residue is within tolerance", () => {
    expect(parseContribution(5.0000000001, "month")).toEqual({ ok: true, amount: 5, interval: "month" });
    expect(parseContribution(1.15 * 10, "month")).toEqual({ ok: true, amount: 11.5, interval: "month" });
  });
  it("should reject an unknown interval", () => {
    expect(parseContribution(10, "week").ok).toBe(false);
  });
});

describe("intervals", () => {
  it("should map intervals to Easypay frequencies and back", () => {
    expect(frequencyFor("month")).toBe("1M");
    expect(frequencyFor("year")).toBe("1Y");
    expect(intervalFromFrequency("1Y")).toBe("year");
    expect(intervalFromFrequency("1M")).toBe("month");
    expect(intervalFromFrequency(undefined)).toBe("month");
  });
  it("should add one month or one year without mutating the input", () => {
    const d = new Date("2026-10-07T12:00:00Z");
    expect(addInterval(d, "month").toISOString()).toBe("2026-11-07T12:00:00.000Z");
    expect(addInterval(d, "year").toISOString()).toBe("2027-10-07T12:00:00.000Z");
    expect(d.toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });
});

describe("nextExpiry", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  it("should extend from now when there is no current expiry", () => {
    expect(nextExpiry(null, "month", now).toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });
  it("should extend from a future expiry, not from now", () => {
    const cur = new Date("2026-10-20T00:00:00Z");
    expect(nextExpiry(cur, "month", now).toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });
  it("should extend from now when the expiry is in the past", () => {
    const cur = new Date("2026-01-01T00:00:00Z");
    expect(nextExpiry(cur, "year", now).toISOString()).toBe("2027-10-07T12:00:00.000Z");
  });
});

it("should format Easypay datetimes in UTC", () => {
  expect(easypayDateTime(new Date("2026-11-07T13:56:42Z"))).toBe("2026-11-07 13:56");
});
