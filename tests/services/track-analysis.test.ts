import { describe, expect, it } from "vitest";
import { deterministicPrePass, planChunks, type Chunk } from "../../src/services/track-analysis.ts";
import type { AnalysisSession } from "../../src/services/track-conventions.ts";

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

// ─── Helper for chunker tests ──────────────────────────────────────────

function makeSession(num: number, trackCount: number): AnalysisSession {
  return {
    sessionNumber: num,
    titleEn: `S${num}`,
    titlePt: `S${num}`,
    sessionDate: null,
    timePeriod: null,
    tracks: Array.from({ length: trackCount }, (_, i) => ({
      position: i,
      originalFilename: `s${num}_${i}.mp3`,
      correctedFilename: `s${num}_${i}.mp3`,
      displayTitleEn: `t${i}`,
      displayTitlePt: `t${i}`,
      corrections: [],
    })),
  };
}

describe("planChunks", () => {
  it("returns a single chunk when total tracks <= 80", () => {
    const sessions = [makeSession(1, 30), makeSession(2, 40)];
    const chunks = planChunks(sessions);
    expect(chunks.length).toBe(1);
    expect(chunks[0].sessions.length).toBe(2);
    expect(chunks[0].sessions[0].partOf).toBeUndefined();
  });

  it("splits sessions across chunks when total tracks > 80, respecting boundaries", () => {
    const sessions = [
      makeSession(1, 50),
      makeSession(2, 50),
      makeSession(3, 50),
    ];
    const chunks = planChunks(sessions);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const total = chunk.sessions.reduce((n, s) => n + s.tracks.length, 0);
      expect(total).toBeLessThanOrEqual(80);
      for (const s of chunk.sessions) {
        expect(s.partOf).toBeUndefined();
      }
    }
  });

  it("splits a single oversized session into sub-chunks with partOf metadata", () => {
    const sessions = [makeSession(1, 200)];
    const chunks = planChunks(sessions);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.sessions.length).toBe(1);
      expect(chunk.sessions[0].partOf).toBeDefined();
      expect(chunk.sessions[0].sessionNumber).toBe(1);
      expect(chunk.sessions[0].tracks.length).toBeLessThanOrEqual(80);
    }
    const partTotals = chunks.map((c) => c.sessions[0].partOf!.partTotal);
    expect(new Set(partTotals).size).toBe(1);
    const partIndices = chunks.map((c) => c.sessions[0].partOf!.partIndex);
    expect(partIndices).toEqual([0, 1, 2, 3].slice(0, chunks.length));
  });

  it("only the first chunk is marked isFirstChunk", () => {
    const sessions = [makeSession(1, 50), makeSession(2, 50), makeSession(3, 50)];
    const chunks = planChunks(sessions);
    expect(chunks[0].isFirstChunk).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].isFirstChunk).toBe(false);
    }
  });
});
