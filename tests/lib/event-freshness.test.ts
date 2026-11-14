import { describe, expect, it } from "vitest";
import { stampEffectiveUpdatedAt } from "../../src/lib/event-freshness.ts";

const d = (iso: string) => new Date(iso);

describe("stampEffectiveUpdatedAt", () => {
  it("should report a teacher edit made after the event's own last edit", () => {
    const [event] = stampEffectiveUpdatedAt([
      {
        updatedAt: d("2026-11-01T10:00:00Z"),
        eventTeachers: [{ teacher: { updatedAt: d("2026-11-13T18:00:00Z") } }],
        eventRetreatGroups: [],
      },
    ]);
    expect(event!.updatedAt).toEqual(d("2026-11-13T18:00:00Z"));
  });

  it("should report a retreat group edit as well", () => {
    const [event] = stampEffectiveUpdatedAt([
      {
        updatedAt: d("2026-11-01T10:00:00Z"),
        eventTeachers: [{ teacher: { updatedAt: d("2026-10-01T00:00:00Z") } }],
        eventRetreatGroups: [{ retreatGroup: { updatedAt: "2026-11-05T09:00:00.000Z" } }],
      },
    ]);
    expect(event!.updatedAt).toEqual(d("2026-11-05T09:00:00Z"));
  });

  it("should keep the event's date when it is the newest", () => {
    const [event] = stampEffectiveUpdatedAt([
      {
        updatedAt: d("2026-11-14T10:00:00Z"),
        eventTeachers: [{ teacher: { updatedAt: d("2026-11-13T18:00:00Z") } }],
      },
    ]);
    expect(event!.updatedAt).toEqual(d("2026-11-14T10:00:00Z"));
  });

  it("should tolerate missing relations and dates", () => {
    const [event] = stampEffectiveUpdatedAt([
      { updatedAt: d("2026-11-14T10:00:00Z"), eventTeachers: [{ teacher: null }] },
    ]);
    expect(event!.updatedAt).toEqual(d("2026-11-14T10:00:00Z"));
  });
});
