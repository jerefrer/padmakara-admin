import { describe, it, expect } from "vitest";
import {
  applyEventOrganizers,
  joinOrganizerNames,
  orderedOrganizers,
} from "../../src/lib/organizer-utils.ts";

const link = (position: number, id: number, name: string, abbreviation: string | null = null) => ({
  position,
  organizer: { id, name, abbreviation },
});

describe("orderedOrganizers", () => {
  it("should sort by position regardless of the order received", () => {
    const result = orderedOrganizers([link(1, 2, "B"), link(0, 1, "A")]);
    expect(result.map((o) => o.name)).toEqual(["A", "B"]);
  });

  it("should skip a link whose organizer is missing", () => {
    expect(orderedOrganizers([{ position: 0, organizer: null }, link(1, 2, "B")])).toHaveLength(1);
  });

  it("should return an empty list when there is no relation", () => {
    expect(orderedOrganizers(undefined)).toEqual([]);
  });
});

describe("joinOrganizerNames", () => {
  it("should join names with a comma and a space", () => {
    expect(joinOrganizerNames([{ name: "A" }, { name: "B" }])).toBe("A · B");
  });

  it("should return null when there are no organizers", () => {
    expect(joinOrganizerNames([])).toBeNull();
  });
});

describe("applyEventOrganizers", () => {
  it("should replace the junction rows with the joined string and the ordered entities", () => {
    const event: Record<string, unknown> = {
      id: 1,
      eventOrganizers: [link(1, 2, "Songtsen CCT"), link(0, 1, "Casa da Cultura do Tibete", "CCT")],
    };
    applyEventOrganizers(event);
    expect(event.organizer).toBe("Casa da Cultura do Tibete · Songtsen CCT");
    expect(event.organizers).toEqual([
      { id: 1, name: "Casa da Cultura do Tibete", abbreviation: "CCT" },
      { id: 2, name: "Songtsen CCT", abbreviation: null },
    ]);
    expect(event).not.toHaveProperty("eventOrganizers");
  });

  it("should set organizer to null when the event has none", () => {
    const event: Record<string, unknown> = { id: 1, eventOrganizers: [] };
    applyEventOrganizers(event);
    expect(event.organizer).toBeNull();
    expect(event.organizers).toEqual([]);
  });

  it("should leave an event loaded without the relation untouched", () => {
    const event: Record<string, unknown> = { id: 1, organizer: "kept" };
    applyEventOrganizers(event);
    expect(event).toEqual({ id: 1, organizer: "kept" });
  });
});
