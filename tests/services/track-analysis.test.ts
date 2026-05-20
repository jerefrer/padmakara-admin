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

// ─── analyzeFolder orchestrator tests ────────────────────────────────────────

import { analyzeFolder, type ProgressEvent } from "../../src/services/track-analysis.ts";

describe("analyzeFolder orchestrator", () => {
  beforeEach(() => mockCreate.mockReset());

  it("returns deterministic-only result when all chunks fail", async () => {
    // Use mockRejectedValueOnce twice (initial call + 1 network retry = 2 total).
    // Permanent mockRejectedValue triggers a Bun 1.3.9 + Vitest 4.0.18 bug
    // where the leftover rejection fires as unhandledRejection post-test.
    mockCreate.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockCreate.mockRejectedValueOnce(new Error("ECONNRESET"));
    const events: ProgressEvent[] = [];
    const result = await analyzeFolder(
      {
        folderName: "2025.04.12 - PP3",
        files: [
          { relativePath: "01_a.mp3", sizeBytes: 1 },
          { relativePath: "02_b.mp3", sizeBytes: 1 },
        ],
        knownGroups: [],
        knownTeachers: [],
        knownPlaces: [],
      },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(result.aiCoverage.tracksAnalyzedByAi).toBe(0);
    expect(result.aiCoverage.tracksFromDeterministicFallback).toBe(2);
    expect(result.aiCoverage.chunksFailed).toBeGreaterThan(0);
    const phases = events.filter((e) => e.type === "phase").map((e) => (e as any).phase);
    expect(phases).toContain("deterministic_parse");
    expect(phases).toContain("ai_analysis");
  });

  it("uses Claude result when single-pass succeeds", async () => {
    mockCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            event: {
              titleEn: "AI Title",
              titlePt: "AI Título",
              startDate: "2025-04-12",
              endDate: "2025-04-12",
              matchedGroupIds: [],
              matchedTeacherIds: [],
              matchedPlaceIds: [],
              folderConventionOk: true,
            },
            sessions: [
              {
                sessionNumber: 1,
                titleEn: "S1",
                titlePt: "S1",
                sessionDate: null,
                timePeriod: null,
                tracks: [
                  {
                    position: 0,
                    originalFilename: "01_a.mp3",
                    correctedFilename: "01_a.mp3",
                    displayTitleEn: "A",
                    displayTitlePt: "A",
                    corrections: [
                      { field: "displayTitlePt", before: "a", after: "A", reason: "case" },
                    ],
                  },
                ],
              },
            ],
            notes: [],
          }),
        },
      ],
    });
    const result = await analyzeFolder(
      {
        folderName: "2025.04.12 - PP3",
        files: [{ relativePath: "01_a.mp3", sizeBytes: 1 }],
        knownGroups: [],
        knownTeachers: [],
        knownPlaces: [],
      },
      () => {},
      new AbortController().signal,
    );
    expect(result.event.titleEn).toBe("AI Title");
    expect(result.aiCoverage.tracksAnalyzedByAi).toBe(1);
    expect(result.aiCoverage.chunksFailed).toBe(0);
    expect(result.sessions[0].tracks[0].corrections.length).toBe(1);
  });

  it("falls back per chunk: one chunk fails, other chunks keep AI corrections", async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      relativePath: `${String(i + 1).padStart(2, "0")}_t.mp3`,
      sizeBytes: 1,
    }));
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              event: {
                titleEn: "T",
                titlePt: "T",
                startDate: null,
                endDate: null,
                matchedGroupIds: [],
                matchedTeacherIds: [],
                matchedPlaceIds: [],
                folderConventionOk: true,
              },
              sessions: [],
              notes: [],
            }),
          },
        ],
      })
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network")) // retry also fails
      .mockResolvedValue({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({ event: null, sessions: [], notes: [] }),
          },
        ],
      });

    const result = await analyzeFolder(
      {
        folderName: "x",
        files,
        knownGroups: [],
        knownTeachers: [],
        knownPlaces: [],
      },
      () => {},
      new AbortController().signal,
    );
    expect(result.aiCoverage.chunks).toBeGreaterThan(1);
    expect(result.aiCoverage.chunksFailed).toBe(1);
    expect(result.aiCoverage.tracksAnalyzedByAi).toBeLessThan(120);
  });

  it("emits chunk_progress events as chunks complete", async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      relativePath: `${String(i + 1).padStart(2, "0")}_t.mp3`,
      sizeBytes: 1,
    }));
    mockCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: JSON.stringify({ event: null, sessions: [], notes: [] }) },
      ],
    });
    const events: ProgressEvent[] = [];
    await analyzeFolder(
      { folderName: "x", files, knownGroups: [], knownTeachers: [], knownPlaces: [] },
      (e) => events.push(e),
      new AbortController().signal,
    );
    const progress = events.filter((e) => e.type === "chunk_progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1] as Extract<ProgressEvent, { type: "chunk_progress" }>;
    expect(last.done).toBe(last.total);
  });
});
