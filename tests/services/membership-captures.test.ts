import { describe, it, expect } from "vitest";
import {
  countedCaptures,
  expiryAfterCapture,
  expiryAfterRefund,
  isPaidCapture,
  listCaptures,
  uncountedPaidCaptures,
} from "../../src/services/membership-captures.ts";

const A = "00000000-0000-4000-8000-00000000c001";
const B = "00000000-0000-4000-8000-00000000c002";

/** A `transactions` entry in the shape stored in production after a successful capture. */
function tx(id: string, date: string, paid: number | null = 5, requested: number | null = 5) {
  return { id, key: "", date, method: "cc", values: { paid, requested, tax: 0, transfer: 0, fixed_fee: 0, variable_fee: 0 }, created_at: date };
}

describe("listCaptures", () => {
  it("should return nothing when the transactions key is absent, as after a failed capture", () => {
    expect(listCaptures({ id: "x", value: 5 })).toEqual([]);
  });

  it("should skip entries without a uuid id", () => {
    expect(listCaptures({ transactions: [{ id: "abc", values: { paid: 5 } }, tx(A, "2026-11-01T10:00:00Z")] }).map((c) => c.id)).toEqual([A]);
  });

  it("should take the earlier of date and created_at as the capture time", () => {
    const [c] = listCaptures({ transactions: [{ ...tx(A, "2026-11-01T10:00:05Z"), created_at: "2026-11-01T10:00:00Z" }] });
    expect(c!.at).toBe(Date.parse("2026-11-01T10:00:00Z"));
  });

  it("should read Easypay's zone-less datetimes as UTC", () => {
    const [c] = listCaptures({ transactions: [tx(A, "2026-11-01 10:00:00")] });
    expect(c!.at).toBe(Date.parse("2026-11-01T10:00:00Z"));
  });
});

describe("isPaidCapture", () => {
  const capture = (paid: number | null, requested: number | null) => listCaptures({ transactions: [tx(A, "2026-11-01T10:00:00Z", paid, requested)] })[0]!;

  it.each([
    [5, 5, true],
    [5, null, true],
    [0, 5, false],
    [null, 5, false],
    [4.99, 5, false],
    [-5, 5, false],
  ])("should treat paid %s for requested %s as paid=%s", (paid, requested, expected) => {
    expect(isPaidCapture(capture(paid, requested))).toBe(expected);
  });
});

describe("uncountedPaidCaptures", () => {
  const sub = { transactions: [tx(B, "2026-11-01T10:00:00Z"), tx(A, "2026-10-01T10:00:00Z")] };

  it("should list every paid capture oldest first when nothing is counted", () => {
    expect(uncountedPaidCaptures(sub, []).map((c) => c.id)).toEqual([A, B]);
  });

  it("should skip a capture recorded with its id", () => {
    const rows = [{ action: "extended", easypayTransactionId: A, createdAt: new Date(), rawSubscription: null }];
    expect(uncountedPaidCaptures(sub, rows).map((c) => c.id)).toEqual([B]);
  });

  it("should skip a capture listed on a legacy credit's snapshot", () => {
    const rows = [{ action: "activated", easypayTransactionId: null, createdAt: new Date("2026-10-01T10:00:03Z"), rawSubscription: { transactions: [tx(A, "2026-10-01T10:00:00Z")] } }];
    expect(uncountedPaidCaptures(sub, rows).map((c) => c.id)).toEqual([B]);
  });

  it("should skip a capture made before the newest legacy credit even when no snapshot lists it", () => {
    const rows = [{ action: "extended", easypayTransactionId: null, createdAt: new Date("2026-11-01T10:00:03Z"), rawSubscription: {} }];
    expect(uncountedPaidCaptures(sub, rows)).toEqual([]);
  });

  it("should ignore rows that did not credit anything when placing the legacy cutoff", () => {
    const rows = [{ action: "ignored", easypayTransactionId: null, createdAt: new Date("2026-12-01T00:00:00Z"), rawSubscription: {} }];
    expect(uncountedPaidCaptures(sub, rows).map((c) => c.id)).toEqual([A, B]);
  });

  it("should treat a capture with no readable time as counted once legacy credits exist", () => {
    const undated = { transactions: [{ id: A, values: { paid: 5 } }] };
    const rows = [{ action: "extended", easypayTransactionId: null, createdAt: new Date("2026-01-01T00:00:00Z"), rawSubscription: {} }];
    expect(uncountedPaidCaptures(undated, rows)).toEqual([]);
    expect(uncountedPaidCaptures(undated, []).map((c) => c.id)).toEqual([A]);
  });

  it("should match ids whatever their case", () => {
    const rows = [{ action: "extended", easypayTransactionId: A.toUpperCase(), createdAt: new Date(), rawSubscription: null }];
    expect(countedCaptures(rows).ids.has(A)).toBe(true);
  });
});

describe("expiryAfterCapture", () => {
  const now = new Date("2026-11-16T12:00:00Z");

  it("should add one interval to a paid-through date still in the future", () => {
    expect(expiryAfterCapture(new Date("2026-11-20T00:00:00Z"), "month", Date.parse("2026-11-16T11:00:00Z"), now)).toEqual(
      new Date("2026-12-20T00:00:00Z"),
    );
  });

  it("should count from the capture when access had already ended", () => {
    expect(expiryAfterCapture(new Date("2026-10-01T00:00:00Z"), "month", Date.parse("2026-11-10T00:00:00Z"), now)).toEqual(
      new Date("2026-12-10T00:00:00Z"),
    );
  });

  it("should never count from a capture time in the future", () => {
    expect(expiryAfterCapture(null, "year", Date.parse("2027-01-01T00:00:00Z"), now)).toEqual(new Date("2027-11-16T12:00:00Z"));
  });

  it("should count from now when the capture time is unknown", () => {
    expect(expiryAfterCapture(null, "month", null, now)).toEqual(new Date("2026-12-16T12:00:00Z"));
  });
});

describe("expiryAfterRefund", () => {
  it("should take one interval off the paid-through date", () => {
    expect(expiryAfterRefund(new Date("2027-01-15T00:00:00Z"), "month", Date.parse("2026-11-10T00:00:00Z"))).toEqual(
      new Date("2026-12-15T00:00:00Z"),
    );
    expect(expiryAfterRefund(new Date("2027-11-15T00:00:00Z"), "year", Date.parse("2026-11-10T00:00:00Z"))).toEqual(
      new Date("2026-11-15T00:00:00Z"),
    );
  });

  it("should stop at the refunded capture's own date", () => {
    expect(expiryAfterRefund(new Date("2026-11-20T00:00:00Z"), "month", Date.parse("2026-11-10T00:00:00Z"))).toEqual(
      new Date("2026-11-10T00:00:00Z"),
    );
  });

  it("should never move the date later than it was", () => {
    expect(expiryAfterRefund(new Date("2026-11-01T00:00:00Z"), "month", Date.parse("2026-11-10T00:00:00Z"))).toEqual(
      new Date("2026-11-01T00:00:00Z"),
    );
  });
});
