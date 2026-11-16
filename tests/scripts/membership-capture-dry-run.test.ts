import { describe, it, expect } from "vitest";
import { replayMember, type LedgerRow, type MemberRow } from "../../src/scripts/membership-capture-dry-run.ts";

const SUB = "00000000-0000-4000-8000-0000000000a1";
const A = "00000000-0000-4000-8000-00000000c001";
const B = "00000000-0000-4000-8000-00000000c002";

const tx = (id: string, date: string, paid = 5) => ({ id, date, created_at: date, method: "cc", values: { paid, requested: 5 } });
const snapshot = (...captures: unknown[]) => ({ id: SUB, frequency: "1M", customer: { key: "user-7" }, transactions: captures });

function row(id: number, action: string, createdAt: string, rawSubscription: unknown): LedgerRow {
  return { id, userId: 7, notificationId: SUB, action, easypayTransactionId: null, rawSubscription, createdAt: new Date(createdAt) };
}

const member = (expires: string): MemberRow => ({
  id: 7, subscriptionSource: "easypay", subscriptionStatus: "active", easypaySubscriptionId: SUB, subscriptionExpiresAt: new Date(expires),
});

describe("replayMember", () => {
  // Two monthly captures, each credited once by the old code a few seconds after it happened.
  const history = [
    row(1, "activated", "2026-10-01T10:00:05Z", snapshot(tx(A, "2026-10-01T10:00:00Z"))),
    row(2, "extended", "2026-11-01T10:00:05Z", snapshot(tx(A, "2026-10-01T10:00:00Z"), tx(B, "2026-11-01T10:00:00Z"))),
    row(3, "ignored", "2026-11-05T00:00:00Z", { id: SUB }),
  ];

  it("should find the current date when the old code credited each capture once", () => {
    const report = replayMember(member("2026-12-01T10:00:05Z"), history);
    expect(report.replayed).toEqual(new Date("2026-12-01T10:00:00Z"));
    expect(Math.abs(report.diffDays!)).toBeLessThan(1);
    expect(report.credits).toBe(2);
    expect(report.paidCaptures).toBe(2);
  });

  it("should report nothing to re-credit at the next notification", () => {
    expect(replayMember(member("2026-12-01T10:00:05Z"), history).next).toBe(0);
  });

  it("should show a month of difference when the old code credited a forged notification", () => {
    const forged = [...history, row(4, "extended", "2026-11-02T00:00:00Z", snapshot(tx(A, "2026-10-01T10:00:00Z"), tx(B, "2026-11-01T10:00:00Z")))];
    const report = replayMember(member("2027-01-01T10:00:05Z"), forged);
    expect(report.diffDays!).toBeLessThan(-29);
    expect(report.credits).toBe(3);
  });

  it("should count a legacy credit whose own snapshot does not list a recent capture as lag", () => {
    const lagging = [row(1, "activated", "2026-10-01T10:00:05Z", { id: SUB, frequency: "1M" })];
    expect(replayMember(member("2026-11-01T10:00:05Z"), lagging).lag).toBe(1);
    expect(replayMember(member("2026-12-01T10:00:05Z"), history).lag).toBe(0);
  });
});
