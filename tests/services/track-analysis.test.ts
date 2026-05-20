import { describe, expect, it } from "vitest";
import { deterministicPrePass } from "../../src/services/track-analysis.ts";

describe("deterministicPrePass", () => {
  it("groups tracks into sessions and returns AnalysisResult shape", () => {
    const result = deterministicPrePass({
      folderName: "2025.04.12-13 - PP3 - CCA - JKR",
      files: [
        { relativePath: "01_intro.mp3", sizeBytes: 100 },
        { relativePath: "02_refugio.mp3", sizeBytes: 100 },
        { relativePath: "03_tonglen.mp3", sizeBytes: 100 },
      ],
      knownGroups: [],
      knownTeachers: [],
      knownPlaces: [],
    });
    expect(result.sessions.length).toBeGreaterThan(0);
    const session0 = result.sessions[0];
    expect(session0).toBeDefined();
    if (!session0) return;
    expect(session0.tracks.length).toBe(3);
    const track0 = session0.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;
    expect(track0.originalFilename).toBe("01_intro.mp3");
    expect(track0.correctedFilename).toBe("01_intro.mp3");
    expect(track0.corrections).toEqual([]);
    expect(result.aiCoverage.tracksAnalyzedByAi).toBe(0);
    expect(result.aiCoverage.tracksFromDeterministicFallback).toBe(3);
    expect(result.aiCoverage.chunks).toBe(0);
  });

  it("uses the basename when relativePath has subfolders", () => {
    const result = deterministicPrePass({
      folderName: "test",
      files: [
        { relativePath: "Morning/01_intro.mp3", sizeBytes: 100 },
      ],
      knownGroups: [],
      knownTeachers: [],
      knownPlaces: [],
    });
    const session0 = result.sessions[0];
    expect(session0).toBeDefined();
    if (!session0) return;
    const track0 = session0.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;
    expect(track0.originalFilename).toBe("01_intro.mp3");
  });

  it("returns event titles set from folder name fallback", () => {
    const result = deterministicPrePass({
      folderName: "2025.04.12 - PP3 - CCA - JKR",
      files: [{ relativePath: "01_intro.mp3", sizeBytes: 100 }],
      knownGroups: [],
      knownTeachers: [],
      knownPlaces: [],
    });
    expect(result.event.titleEn).not.toBeNull();
    expect(result.event.folderConventionOk).toBe(true);
  });

  it("flags folderConventionOk=false when folder name has no date", () => {
    const result = deterministicPrePass({
      folderName: "random folder",
      files: [{ relativePath: "01_intro.mp3", sizeBytes: 100 }],
      knownGroups: [],
      knownTeachers: [],
      knownPlaces: [],
    });
    expect(result.event.folderConventionOk).toBe(false);
  });
});
