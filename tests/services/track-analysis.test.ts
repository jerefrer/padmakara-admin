import { describe, expect, it, vi, beforeEach } from "vitest";
import { deterministicPrePass, planChunks, type Chunk } from "../../src/services/track-analysis.ts";
import type { AnalysisSession } from "../../src/services/track-conventions.ts";

// ─── Mock the Anthropic SDK ───────────────────────────────────────────────────

// vi.hoisted() runs before the vi.mock factory (and before all imports), so
// `mockCreate` is available in the factory closure.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  // Use a real class so Reflect.construct / instanceof checks work in Bun.
  class MockAnthropic {
    messages = { create: mockCreate };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

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

// ─── callClaudeForChunk tests ─────────────────────────────────────────────────

import {
  callClaudeForChunk,
  type CallClaudeOptions,
} from "../../src/services/track-analysis.ts";

function validResponseJSON() {
  return JSON.stringify({
    event: {
      titleEn: "Test",
      titlePt: "Teste",
      startDate: "2025-04-12",
      endDate: "2025-04-13",
      matchedGroupIds: [],
      matchedTeacherIds: [],
      matchedPlaceIds: [],
      folderConventionOk: true,
    },
    sessions: [],
    notes: [],
  });
}

function baseOptions(): CallClaudeOptions {
  return {
    folderName: "2025.04.12-13 - PP3",
    chunk: { isFirstChunk: true, sessions: [] },
    knownGroups: [],
    knownTeachers: [],
    knownPlaces: [],
    signal: new AbortController().signal,
  };
}

describe("callClaudeForChunk", () => {
  beforeEach(() => mockCreate.mockReset());

  it("returns parsed response on a successful end_turn", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: validResponseJSON() }],
    });
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.event?.titleEn).toBe("Test");
  });

  it("returns error.kind=max_tokens when stop_reason is max_tokens", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "{ partial" }],
    });
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("max_tokens");
  });

  it("returns error.kind=invalid_json on parse failure", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not JSON at all" }],
    });
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_json");
  });

  it("returns error.kind=schema_violation on Zod failure", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"event": null, "sessions": "nope", "notes": []}' }],
    });
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("schema_violation");
  });

  it("returns error.kind=rate_limit on 429", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    mockCreate.mockRejectedValueOnce(err);
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("rate_limit");
  });

  it("returns error.kind=network on other thrown errors", async () => {
    mockCreate.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await callClaudeForChunk(baseOptions());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("network");
  });

  it("includes the partial-session instruction when chunk has partOf", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: validResponseJSON() }],
    });
    const opts = baseOptions();
    opts.chunk.sessions = [
      {
        sessionNumber: 1,
        titleEn: "X",
        titlePt: "X",
        sessionDate: null,
        timePeriod: null,
        tracks: [],
        partOf: { partIndex: 1, partTotal: 3, sessionRef: 1 },
      },
    ];
    await callClaudeForChunk(opts);
    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userPrompt).toMatch(/part 2 of 3/i);
    expect(userPrompt).toMatch(/do not infer session-level/i);
  });
});
