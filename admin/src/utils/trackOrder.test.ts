import { describe, it, expect } from "vitest";
import { compareTracks, movedTrackIds } from "./trackOrder";

describe("movedTrackIds", () => {
  const tracks = [{ id: 10 }, { id: 11 }, { id: 12 }];

  it("should swap a track with the one above when moved up", () => {
    expect(movedTrackIds(tracks, 2, -1)).toEqual([10, 12, 11]);
  });

  it("should swap a track with the one below when moved down", () => {
    expect(movedTrackIds(tracks, 0, 1)).toEqual([11, 10, 12]);
  });

  it("should refuse to move the first track up or the last one down", () => {
    expect(movedTrackIds(tracks, 0, -1)).toBeNull();
    expect(movedTrackIds(tracks, 2, 1)).toBeNull();
  });

  it("should refuse when a track of the session is not saved yet", () => {
    expect(movedTrackIds([{ id: 10 }, {}], 0, 1)).toBeNull();
  });
});

describe("compareTracks", () => {
  it("should put saved positions first, in their order", () => {
    const sorted = [
      { trackNumber: 1, position: 2 },
      { trackNumber: 9, position: 1 },
      { trackNumber: 2, position: null },
    ].sort(compareTracks);
    expect(sorted.map((t) => t.trackNumber)).toEqual([9, 1, 2]);
  });

  it("should order tracks without a position by number, the original before its translation", () => {
    const sorted = [
      { trackNumber: 92, isTranslation: true, originalLanguage: "pt" },
      { trackNumber: 93, originalLanguage: "en" },
      { trackNumber: 92, originalLanguage: "en" },
    ].sort(compareTracks);
    expect(sorted.map((t) => `${t.trackNumber}${t.originalLanguage}`)).toEqual(["92en", "92pt", "93en"]);
  });
});
