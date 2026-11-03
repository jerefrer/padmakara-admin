import { describe, it, expect } from "vitest";
import { chronologicalRenumbering, type SessionOrderInput } from "../../src/services/session-order.ts";

function s(id: number, sessionNumber: number, sessionDate: string | null, timePeriod: string | null = "morning"): SessionOrderInput {
  return { id, sessionNumber, sessionDate, timePeriod };
}

describe("chronologicalRenumbering", () => {
  it("should move a session added last into its place by date and period", () => {
    // André's event 923: "October 10 – Afternoon" was created as session 4.
    const changes = chronologicalRenumbering([
      s(1, 1, "2026-10-10", "morning"),
      s(2, 2, "2026-10-11", "morning"),
      s(3, 3, "2026-10-11", "afternoon"),
      s(4, 4, "2026-10-10", "afternoon"),
    ]);
    expect(Object.fromEntries(changes)).toEqual({ 4: 2, 2: 3, 3: 4 });
  });

  it("should change nothing when sessions are already in order", () => {
    expect(chronologicalRenumbering([s(1, 1, "2026-10-10"), s(2, 2, "2026-10-10", "evening")]).size).toBe(0);
  });

  it("should close the gap left by a deleted session", () => {
    expect(Object.fromEntries(chronologicalRenumbering([s(1, 1, "2026-10-10"), s(3, 3, "2026-10-11")]))).toEqual({ 3: 2 });
  });

  it("should keep undated sessions after dated ones, in their current order", () => {
    const changes = chronologicalRenumbering([s(1, 1, null), s(2, 2, null), s(3, 3, "2026-10-10")]);
    expect(Object.fromEntries(changes)).toEqual({ 3: 1, 1: 2, 2: 3 });
  });

  it("should leave an event with no dates untouched", () => {
    expect(chronologicalRenumbering([s(1, 1, null), s(2, 2, null)]).size).toBe(0);
  });
});
