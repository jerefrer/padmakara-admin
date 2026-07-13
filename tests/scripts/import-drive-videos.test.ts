import { describe, it, expect } from "vitest";
import {
  parseDriveVideoName,
  assignPositions,
} from "../../src/scripts/import-drive-videos.ts";

describe("parseDriveVideoName", () => {
  it("parses a leading YYYYMMDDHHMMSS timestamp", () => {
    expect(parseDriveVideoName("20090621161350.mpg")).toEqual({
      date: "2009-06-21",
      time: "16:13:50",
    });
  });

  it("parses regardless of extension", () => {
    expect(parseDriveVideoName("20240418093000.mp4")).toEqual({
      date: "2024-04-18",
      time: "09:30:00",
    });
    expect(parseDriveVideoName("20240418093000.mov")).toEqual({
      date: "2024-04-18",
      time: "09:30:00",
    });
  });

  it("ignores trailing text after the timestamp", () => {
    expect(parseDriveVideoName("20090621161350 - morning session.mpg")).toEqual({
      date: "2009-06-21",
      time: "16:13:50",
    });
  });

  it("returns null when the name has no leading timestamp", () => {
    expect(parseDriveVideoName("morning-session.mpg")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseDriveVideoName("")).toBeNull();
  });

  it("returns null when the timestamp is too short", () => {
    expect(parseDriveVideoName("200906211613.mpg")).toBeNull();
  });
});

describe("assignPositions", () => {
  it("assigns ascending positions per date, ordered by time", () => {
    const files = [
      { id: "b", name: "20090621180000.mpg" },
      { id: "a", name: "20090621161350.mpg" },
    ];
    const result = assignPositions(files);
    expect(result).toEqual([
      { id: "a", name: "20090621161350.mpg", date: "2009-06-21", time: "16:13:50", position: 0 },
      { id: "b", name: "20090621180000.mpg", date: "2009-06-21", time: "18:00:00", position: 1 },
    ]);
  });

  it("resets position to 0 for each new date", () => {
    const files = [
      { id: "a", name: "20090621161350.mpg" },
      { id: "b", name: "20090621180000.mpg" },
      { id: "c", name: "20090622090000.mp4" },
    ];
    const result = assignPositions(files);
    expect(result.map((f) => ({ id: f.id, date: f.date, position: f.position }))).toEqual([
      { id: "a", date: "2009-06-21", position: 0 },
      { id: "b", date: "2009-06-21", position: 1 },
      { id: "c", date: "2009-06-22", position: 0 },
    ]);
  });

  it("sorts by date across out-of-order input", () => {
    const files = [
      { id: "c", name: "20090623090000.mpg" },
      { id: "a", name: "20090621161350.mpg" },
      { id: "b", name: "20090622090000.mpg" },
    ];
    const result = assignPositions(files);
    expect(result.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("drops files with no parseable leading timestamp", () => {
    const files = [
      { id: "a", name: "20090621161350.mpg" },
      { id: "b", name: "readme.txt" },
    ];
    const result = assignPositions(files);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("returns an empty array for no files", () => {
    expect(assignPositions([])).toEqual([]);
  });
});
