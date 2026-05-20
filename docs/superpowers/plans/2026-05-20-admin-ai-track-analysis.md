# Admin AI Track Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SSE-streamed Claude analysis pass between folder drop and preview in the admin event-creation flow, so files are intelligently grouped into sessions, typos and accents are corrected on display titles, and the corrected ASCII filename becomes the S3 key.

**Architecture:** New backend service `track-analysis.ts` orchestrates a deterministic pre-pass (reusing existing `track-parser.ts`), then chunks tracks if needed (session boundary preference, split when degenerate), calls Claude in parallel with concurrency=4, validates JSON with Zod, falls back to deterministic per failed chunk. Exposed via SSE-streaming route `POST /api/admin/import/analyze`. Frontend replaces the synchronous drop-parse with a streaming fetch + spinner, surfaces per-track correction badges in the existing `SessionPreview`, and uses corrected filenames as S3 keys at upload time.

**Tech Stack:** Hono + Bun (backend), `@anthropic-ai/sdk` (Sonnet 4.6), Zod v4 (validation), Vitest (backend tests), React-admin + Vite (admin UI).

**Test strategy:** Heavy backend testing with mocked Anthropic SDK ($0, deterministic). No admin component tests — manual browser verification per a checklist at the end of the plan. Spec: `docs/superpowers/specs/2026-05-20-admin-ai-track-analysis-design.md`.

---

## Task 1: Shared building blocks — `track-conventions.ts`

**Why first:** All downstream code (service, route, prompts) imports from this module. No external dependencies.

**Files:**
- Create: `src/services/track-conventions.ts`
- Test: `tests/services/track-conventions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/services/track-conventions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FOLDER_NAME_CONVENTION,
  FILENAME_CONVENTION,
  WRITING_RULES,
  trackCorrectionSchema,
  noteSchema,
  analysisResultSchema,
} from "../../src/services/track-conventions.ts";

describe("track-conventions", () => {
  describe("prompt constants", () => {
    it("exports non-empty folder name convention text", () => {
      expect(FOLDER_NAME_CONVENTION).toMatch(/YYYY\.MM\.DD/);
    });
    it("exports non-empty filename convention text", () => {
      expect(FILENAME_CONVENTION).toMatch(/ASCII|accent/i);
    });
    it("exports non-empty writing rules", () => {
      expect(WRITING_RULES).toMatch(/accent/i);
    });
  });

  describe("trackCorrectionSchema", () => {
    it("accepts a valid correction", () => {
      const ok = trackCorrectionSchema.safeParse({
        field: "displayTitlePt",
        before: "Refugio",
        after: "Refúgio",
        reason: "missing diacritic",
      });
      expect(ok.success).toBe(true);
    });
    it("rejects an unknown field", () => {
      const bad = trackCorrectionSchema.safeParse({
        field: "nope",
        before: "a",
        after: "b",
        reason: "r",
      });
      expect(bad.success).toBe(false);
    });
  });

  describe("noteSchema", () => {
    it("accepts info severity without relatedFilename", () => {
      const ok = noteSchema.safeParse({ severity: "info", message: "ok" });
      expect(ok.success).toBe(true);
    });
    it("accepts warning with relatedFilename", () => {
      const ok = noteSchema.safeParse({
        severity: "warning",
        message: "orphan",
        relatedFilename: "99_bonus.mp3",
      });
      expect(ok.success).toBe(true);
    });
    it("rejects severity outside info|warning", () => {
      const bad = noteSchema.safeParse({ severity: "error", message: "x" });
      expect(bad.success).toBe(false);
    });
  });

  describe("analysisResultSchema", () => {
    it("accepts a minimal valid result", () => {
      const ok = analysisResultSchema.safeParse({
        aiCoverage: {
          totalTracks: 0,
          tracksAnalyzedByAi: 0,
          tracksFromDeterministicFallback: 0,
          chunks: 0,
          chunksFailed: 0,
        },
        event: {
          titleEn: null,
          titlePt: null,
          startDate: null,
          endDate: null,
          matchedGroupIds: [],
          matchedTeacherIds: [],
          matchedPlaceIds: [],
          folderConventionOk: true,
        },
        sessions: [],
        notes: [],
      });
      expect(ok.success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-conventions.test.ts'`

Expected: FAIL — `Cannot find module ... track-conventions`.

- [ ] **Step 3: Create the module**

Create `src/services/track-conventions.ts`:

```ts
import { z } from "zod";

export const FOLDER_NAME_CONVENTION = `
Expected folder name format: YYYY.MM.DD[-DD] - GROUP - PLACE - TEACHER
Example: "2025.04.12-13 - PP3 - CCA - JKR"

Rules:
- Date at the start, range allowed with a hyphen for the end day.
- Sections separated by " - " (space-hyphen-space).
- GROUP, PLACE, TEACHER are short uppercase abbreviations matched against
  the lists you receive in the user message.
- Deviations from this format are allowed — flag them in notes if present.
`.trim();

export const FILENAME_CONVENTION = `
Expected filename format: NN_descriptive_title.mp3 (or .m4a, .wav, .flac, .ogg)

Rules:
- Two-digit track number at the start, separated by underscore or hyphen.
- ASCII only — never any accents or diacritics in the filename itself.
- Underscores instead of spaces.
- Common deviations to tolerate (and silently correct): typos, missing
  underscores, mixed case, missing leading zero on track numbers.
`.trim();

export const WRITING_RULES = `
Display titles (event titleEn/titlePt, session titleEn/titlePt, track
displayTitleEn/displayTitlePt):
- Capitalization: Title Case for English, sentence case for Portuguese.
- Accents: PRESENT and correct in Portuguese ("Refúgio", "Introdução",
  "Meditação"). Generally absent in English unless borrowed ("café").
- Fix obvious typos: "introducao" → "Introdução"; "refugio" → "Refúgio".

Corrected filenames (correctedFilename):
- ASCII only — NEVER any accents. If you fix a Portuguese typo on the
  display title, the filename should carry the ASCII-folded form of the
  corrected title (e.g., display "Refúgio" → filename slug "refugio").
- Underscores, not spaces. Two-digit track numbers with leading zero.
- Preserve any existing track numbering from the original filename.
- Audio extensions only: .mp3 .m4a .wav .flac .ogg

Notes (free-form warnings):
- Add a note when: a filename has no clear track number, two tracks could
  belong to either of two sessions, a track date conflicts with the folder
  date, the folder name deviates from FOLDER_NAME_CONVENTION, or anything
  else looks suspicious.
- Severity: "info" for things worth knowing, "warning" for things the
  admin should review.
`.trim();

// ─── Zod schemas ──────────────────────────────────────────────────────

export const trackCorrectionSchema = z.object({
  field: z.enum(["filename", "displayTitleEn", "displayTitlePt"]),
  before: z.string(),
  after: z.string(),
  reason: z.string(),
});
export type TrackCorrection = z.infer<typeof trackCorrectionSchema>;

export const noteSchema = z.object({
  severity: z.enum(["info", "warning"]),
  message: z.string(),
  relatedFilename: z.string().optional(),
});
export type AnalysisNote = z.infer<typeof noteSchema>;

export const analysisTrackSchema = z.object({
  position: z.number().int().nonnegative(),
  originalFilename: z.string(),
  correctedFilename: z.string(),
  displayTitleEn: z.string(),
  displayTitlePt: z.string(),
  corrections: z.array(trackCorrectionSchema),
});
export type AnalysisTrack = z.infer<typeof analysisTrackSchema>;

export const analysisSessionSchema = z.object({
  sessionNumber: z.number().int().positive(),
  titleEn: z.string(),
  titlePt: z.string(),
  sessionDate: z.string().nullable(),
  timePeriod: z.enum(["morning", "afternoon", "evening"]).nullable(),
  tracks: z.array(analysisTrackSchema),
});
export type AnalysisSession = z.infer<typeof analysisSessionSchema>;

export const aiCoverageSchema = z.object({
  totalTracks: z.number().int().nonnegative(),
  tracksAnalyzedByAi: z.number().int().nonnegative(),
  tracksFromDeterministicFallback: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  chunksFailed: z.number().int().nonnegative(),
});
export type AiCoverage = z.infer<typeof aiCoverageSchema>;

export const analysisEventSchema = z.object({
  titleEn: z.string().nullable(),
  titlePt: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  matchedGroupIds: z.array(z.string()),
  matchedTeacherIds: z.array(z.string()),
  matchedPlaceIds: z.array(z.string()),
  folderConventionOk: z.boolean(),
});
export type AnalysisEvent = z.infer<typeof analysisEventSchema>;

export const analysisResultSchema = z.object({
  aiCoverage: aiCoverageSchema,
  event: analysisEventSchema,
  sessions: z.array(analysisSessionSchema),
  notes: z.array(noteSchema),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// ─── Per-chunk Claude response schema ─────────────────────────────────
// Claude returns one of these per call. `event` is non-null only for
// the first chunk; null on subsequent chunks of a chunked analysis.

export const claudeChunkResponseSchema = z.object({
  event: analysisEventSchema.nullable(),
  sessions: z.array(analysisSessionSchema),
  notes: z.array(noteSchema),
});
export type ClaudeChunkResponse = z.infer<typeof claudeChunkResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-conventions.test.ts'`

Expected: PASS, all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/track-conventions.ts tests/services/track-conventions.test.ts
git commit -m "feat(import): add track-conventions shared module"
```

---

## Task 2: Deterministic pre-pass helper

**Why:** Wraps the existing `parseTrackFilename` + `inferSessions` into a single function that emits an `AnalysisResult`-shaped output suitable for the fallback and the Claude prompt.

**Files:**
- Modify: `src/services/track-analysis.ts` (create new file)
- Test: `tests/services/track-analysis.test.ts` (create new file)

- [ ] **Step 1: Write the failing test**

Create `tests/services/track-analysis.test.ts`:

```ts
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
    expect(result.sessions[0].tracks.length).toBe(3);
    expect(result.sessions[0].tracks[0].originalFilename).toBe("01_intro.mp3");
    expect(result.sessions[0].tracks[0].correctedFilename).toBe("01_intro.mp3");
    expect(result.sessions[0].tracks[0].corrections).toEqual([]);
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
    expect(result.sessions[0].tracks[0].originalFilename).toBe("01_intro.mp3");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: FAIL — module not found.

- [ ] **Step 3: Create the service file with `deterministicPrePass`**

Create `src/services/track-analysis.ts`:

```ts
import { parseTrackFilename, inferSessions, type ParsedTrack } from "./track-parser.ts";
import type { AnalysisResult, AnalysisSession, AnalysisTrack, AnalysisEvent } from "./track-conventions.ts";

// ─── Input shape (shared with the orchestrator) ──────────────────────

export interface KnownGroup {
  id: string;
  nameEn: string;
  namePt: string;
  slug: string;
  abbreviation: string;
}
export interface KnownTeacher {
  id: string;
  name: string;
  abbreviation: string;
}
export interface KnownPlace {
  id: string;
  name: string;
  abbreviation: string;
}
export interface AnalyzeFolderInput {
  folderName: string;
  files: { relativePath: string; sizeBytes: number }[];
  knownGroups: KnownGroup[];
  knownTeachers: KnownTeacher[];
  knownPlaces: KnownPlace[];
}

// ─── Folder-name regex for the convention check ──────────────────────

const FOLDER_DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})(?:-(\d{2}))?/;

// ─── Deterministic pre-pass ──────────────────────────────────────────

function basenameOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

export function deterministicPrePass(input: AnalyzeFolderInput): AnalysisResult {
  const parsedTracks: ParsedTrack[] = input.files.map((f) =>
    parseTrackFilename(basenameOf(f.relativePath)),
  );
  const inferred = inferSessions(parsedTracks);

  const sessions: AnalysisSession[] = inferred.map((s, idx) => ({
    sessionNumber: idx + 1,
    titleEn: s.titleEn,
    titlePt: s.titleEn,
    sessionDate: s.date ?? null,
    timePeriod: s.timePeriod ?? null,
    tracks: s.tracks.map<AnalysisTrack>((t, pos) => ({
      position: pos,
      originalFilename: t.originalFilename,
      correctedFilename: t.originalFilename,
      displayTitleEn: t.title,
      displayTitlePt: t.title,
      corrections: [],
    })),
  }));

  const event = buildDeterministicEvent(input.folderName);
  const totalTracks = input.files.length;

  return {
    aiCoverage: {
      totalTracks,
      tracksAnalyzedByAi: 0,
      tracksFromDeterministicFallback: totalTracks,
      chunks: 0,
      chunksFailed: 0,
    },
    event,
    sessions,
    notes: [],
  };
}

function buildDeterministicEvent(folderName: string): AnalysisEvent {
  const match = folderName.match(FOLDER_DATE_RE);
  const folderConventionOk = match !== null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (match) {
    const [, year, month, startDay, endDay] = match;
    startDate = `${year}-${month}-${startDay}`;
    endDate = endDay ? `${year}-${month}-${endDay}` : startDate;
  }
  return {
    titleEn: folderName.trim() || null,
    titlePt: folderName.trim() || null,
    startDate,
    endDate,
    matchedGroupIds: [],
    matchedTeacherIds: [],
    matchedPlaceIds: [],
    folderConventionOk,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/track-analysis.ts tests/services/track-analysis.test.ts
git commit -m "feat(import): deterministic pre-pass for track analysis"
```

---

## Task 3: Chunker (session boundary preference + degenerate split)

**Why:** Decides single-pass vs chunked, and when chunked, packs sessions into bounded chunks. Handles the degenerate case (one session larger than the hard max).

**Files:**
- Modify: `src/services/track-analysis.ts`
- Modify: `tests/services/track-analysis.test.ts`

- [ ] **Step 1: Add failing tests for the chunker**

Append to `tests/services/track-analysis.test.ts`:

```ts
import { planChunks, type Chunk } from "../../src/services/track-analysis.ts";

function makeSession(num: number, trackCount: number) {
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
      // Sessions in a chunk are whole (no partOf marker)
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
    expect(new Set(partTotals).size).toBe(1); // all sub-chunks agree on N
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: FAIL — `planChunks` not exported.

- [ ] **Step 3: Add `planChunks` to the service**

Append to `src/services/track-analysis.ts`:

```ts
// ─── Chunker ──────────────────────────────────────────────────────────

const SINGLE_PASS_THRESHOLD = 80;
const CHUNK_TARGET = 60;
const CHUNK_HARD_MAX = 80;

export interface PartOf {
  partIndex: number;
  partTotal: number;
  sessionRef: number; // sessionNumber of the original session
}

export interface PlannedSession extends AnalysisSession {
  partOf?: PartOf;
}

export interface Chunk {
  isFirstChunk: boolean;
  sessions: PlannedSession[];
}

export function planChunks(sessions: AnalysisSession[]): Chunk[] {
  const totalTracks = sessions.reduce((n, s) => n + s.tracks.length, 0);
  if (totalTracks <= SINGLE_PASS_THRESHOLD) {
    return [{ isFirstChunk: true, sessions }];
  }

  const chunks: Chunk[] = [];
  let current: PlannedSession[] = [];
  let currentTotal = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push({ isFirstChunk: chunks.length === 0, sessions: current });
      current = [];
      currentTotal = 0;
    }
  };

  for (const session of sessions) {
    if (session.tracks.length > CHUNK_HARD_MAX) {
      // Degenerate: split the session itself.
      flush();
      const partTotal = Math.ceil(session.tracks.length / CHUNK_TARGET);
      const subSize = Math.ceil(session.tracks.length / partTotal);
      for (let i = 0; i < partTotal; i++) {
        const slice = session.tracks.slice(i * subSize, (i + 1) * subSize);
        chunks.push({
          isFirstChunk: chunks.length === 0,
          sessions: [
            {
              ...session,
              tracks: slice,
              partOf: { partIndex: i, partTotal, sessionRef: session.sessionNumber },
            },
          ],
        });
      }
      continue;
    }
    if (currentTotal + session.tracks.length > CHUNK_HARD_MAX) {
      flush();
    }
    current.push(session);
    currentTotal += session.tracks.length;
  }
  flush();
  return chunks;
}
```

(Also update the existing `import type` line near the top to also import
`AnalysisSession` if it isn't already.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: PASS, 8 tests green (4 previous + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/track-analysis.ts tests/services/track-analysis.test.ts
git commit -m "feat(import): chunker with session-boundary preference"
```

---

## Task 4: Claude call per chunk (mocked SDK, all failure paths)

**Why:** This is where every documented failure mode triggers. Isolated function makes it easy to test each path.

**Files:**
- Modify: `src/services/track-analysis.ts`
- Modify: `tests/services/track-analysis.test.ts`
- Modify: `src/config.ts` (only if `config.anthropic` isn't already wired)

- [ ] **Step 1: Verify config wiring**

Run: `grep -n "anthropic" src/config.ts`

If `config.anthropic.apiKey` and `config.anthropic.model` already exist (they do — `import-inference.ts` uses them), skip the config edit. If not, add:

```ts
anthropic: {
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
},
```

- [ ] **Step 2: Write failing tests for `callClaudeForChunk`**

Append to `tests/services/track-analysis.test.ts`:

```ts
import { vi } from "vitest";
import {
  callClaudeForChunk,
  type CallClaudeOptions,
} from "../../src/services/track-analysis.ts";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create },
    })),
    __mockCreate: create,
  };
});

import AnthropicMock from "@anthropic-ai/sdk";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreate = (AnthropicMock as any).__mockCreate ?? (AnthropicMock as any).mock?.results?.[0]?.value?.messages?.create;

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
```

- [ ] **Step 3: Run tests to verify failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: FAIL — `callClaudeForChunk` not exported.

- [ ] **Step 4: Implement `callClaudeForChunk`**

Append to `src/services/track-analysis.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import {
  FOLDER_NAME_CONVENTION,
  FILENAME_CONVENTION,
  WRITING_RULES,
  claudeChunkResponseSchema,
  type ClaudeChunkResponse,
} from "./track-conventions.ts";

export type ChunkErrorKind =
  | "max_tokens"
  | "invalid_json"
  | "schema_violation"
  | "rate_limit"
  | "network"
  | "timeout";

export interface CallClaudeOptions {
  folderName: string;
  chunk: Chunk;
  knownGroups: KnownGroup[];
  knownTeachers: KnownTeacher[];
  knownPlaces: KnownPlace[];
  signal: AbortSignal;
}

export type ChunkResult =
  | { ok: true; value: ClaudeChunkResponse }
  | { ok: false; error: { kind: ChunkErrorKind; detail?: string } };

const SYSTEM_PROMPT = `
You assist an admin ingesting audio files for a Buddhist retreat centre.
Each event has multiple sessions (one or more per day); each session has
tracks (individual audio files).

${FOLDER_NAME_CONVENTION}

${FILENAME_CONVENTION}

${WRITING_RULES}

Output: a single JSON object matching the schema given in the user
message. No prose, no markdown fences, just JSON.
`.trim();

function buildUserPrompt(opts: CallClaudeOptions): string {
  const partialNote = opts.chunk.sessions
    .filter((s) => s.partOf)
    .map(
      (s) =>
        `Note: this chunk contains part ${s.partOf!.partIndex + 1} of ${s.partOf!.partTotal} of session ${s.partOf!.sessionRef}. Do not infer session-level fields (titleEn, titlePt, sessionDate, timePeriod) — copy them as given. Correct only the tracks listed.`,
    )
    .join("\n");

  const eventPart = opts.chunk.isFirstChunk
    ? `Folder name received: ${opts.folderName}\n`
    : `(Subsequent chunk — do not return event metadata. Set "event": null.)\n`;

  return [
    eventPart,
    partialNote && `\n${partialNote}\n`,
    "Known groups (id, abbreviation, names):",
    JSON.stringify(opts.knownGroups, null, 2),
    "Known teachers (id, abbreviation, name):",
    JSON.stringify(opts.knownTeachers, null, 2),
    "Known places (id, abbreviation, name):",
    JSON.stringify(opts.knownPlaces, null, 2),
    "\nDeterministic pre-pass for the tracks in this chunk:",
    JSON.stringify(opts.chunk.sessions, null, 2),
    "\nReturn JSON of shape:",
    `{
  "event": { titleEn, titlePt, startDate, endDate, matchedGroupIds, matchedTeacherIds, matchedPlaceIds, folderConventionOk } | null,
  "sessions": [{ sessionNumber, titleEn, titlePt, sessionDate, timePeriod, tracks: [{ position, originalFilename, correctedFilename, displayTitleEn, displayTitlePt, corrections: [{ field, before, after, reason }] }] }],
  "notes": [{ severity, message, relatedFilename? }]
}`,
    "\nFor every field you change relative to the deterministic pre-pass, add a corrections entry. For anything suspicious (orphan file, missing track number, deviation from the folder convention, ambiguous date), add a notes entry.",
  ]
    .filter(Boolean)
    .join("\n");
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return cachedClient;
}

export async function callClaudeForChunk(opts: CallClaudeOptions): Promise<ChunkResult> {
  try {
    const message = await client().messages.create(
      {
        model: config.anthropic.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(opts) }],
      },
      { signal: opts.signal },
    );

    if (message.stop_reason === "max_tokens") {
      return { ok: false, error: { kind: "max_tokens" } };
    }

    const textBlock = message.content.find((b: { type: string }) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    const text = textBlock?.text ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: { kind: "invalid_json", detail: (e as Error).message } };
    }

    const validated = claudeChunkResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: { kind: "schema_violation", detail: validated.error.message } };
    }
    return { ok: true, value: validated.data };
  } catch (e: unknown) {
    const err = e as { status?: number; name?: string; message?: string };
    if (err.status === 429) return { ok: false, error: { kind: "rate_limit" } };
    if (err.name === "AbortError") return { ok: false, error: { kind: "timeout" } };
    return { ok: false, error: { kind: "network", detail: err.message } };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: PASS, all tests green (previous + 7 new).

- [ ] **Step 6: Commit**

```bash
git add src/services/track-analysis.ts tests/services/track-analysis.test.ts
git commit -m "feat(import): per-chunk Claude call with typed failure modes"
```

---

## Task 5: Orchestrator `analyzeFolder` (retry, fallback, merge, progress events)

**Why:** Combines pre-pass + chunker + Claude calls + per-chunk retry/fallback + merge into a single async function the route handler calls.

**Files:**
- Modify: `src/services/track-analysis.ts`
- Modify: `tests/services/track-analysis.test.ts`

- [ ] **Step 1: Add failing orchestrator tests**

Append to `tests/services/track-analysis.test.ts`:

```ts
import { analyzeFolder, type ProgressEvent } from "../../src/services/track-analysis.ts";

describe("analyzeFolder orchestrator", () => {
  beforeEach(() => mockCreate.mockReset());

  it("returns deterministic-only result when all chunks fail", async () => {
    mockCreate.mockRejectedValue(new Error("ECONNRESET")); // every call fails
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
    // Force chunked mode with 3 sessions of 40 tracks each (120 total > 80)
    const files = Array.from({ length: 120 }, (_, i) => ({
      relativePath: `${String(i + 1).padStart(2, "0")}_t.mp3`,
      sizeBytes: 1,
    }));
    // First call OK, second call fails, third call OK
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
    expect(result.aiCoverage.tracksAnalyzedByAi).toBeGreaterThan(0);
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
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: FAIL — `analyzeFolder` and `ProgressEvent` not exported.

- [ ] **Step 3: Implement orchestrator**

Append to `src/services/track-analysis.ts`:

```ts
// ─── Orchestrator ─────────────────────────────────────────────────────

const PARALLEL_CONCURRENCY = 4;

export type ProgressEvent =
  | { type: "phase"; phase: "scanning" }
  | { type: "phase"; phase: "deterministic_parse"; totalFiles: number; totalSessions: number }
  | { type: "phase"; phase: "ai_analysis"; totalChunks: number }
  | { type: "chunk_progress"; done: number; total: number }
  | { type: "chunk_failed"; chunkIndex: number; reason: ChunkErrorKind; willFallback: true };

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function analyzeFolder(
  input: AnalyzeFolderInput,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  onProgress({ type: "phase", phase: "scanning" });

  const determ = deterministicPrePass(input);
  onProgress({
    type: "phase",
    phase: "deterministic_parse",
    totalFiles: input.files.length,
    totalSessions: determ.sessions.length,
  });

  const chunks = planChunks(determ.sessions);
  onProgress({ type: "phase", phase: "ai_analysis", totalChunks: chunks.length });

  let done = 0;
  const chunkResults = await withConcurrency(chunks, PARALLEL_CONCURRENCY, async (chunk, index) => {
    const result = await runChunkWithRetries(input, chunk, signal);
    done++;
    onProgress({ type: "chunk_progress", done, total: chunks.length });
    if (!result.ok) {
      onProgress({
        type: "chunk_failed",
        chunkIndex: index,
        reason: result.error.kind,
        willFallback: true,
      });
    }
    return { chunk, result };
  });

  return mergeChunkResults(determ, chunkResults);
}

async function runChunkWithRetries(
  input: AnalyzeFolderInput,
  chunk: Chunk,
  signal: AbortSignal,
): Promise<ChunkResult> {
  const opts: CallClaudeOptions = {
    folderName: input.folderName,
    chunk,
    knownGroups: input.knownGroups,
    knownTeachers: input.knownTeachers,
    knownPlaces: input.knownPlaces,
    signal,
  };

  // First attempt
  let result = await callClaudeForChunk(opts);
  if (result.ok) return result;

  // Per-kind retry logic
  if (result.error.kind === "rate_limit") {
    for (const delay of [2000, 4000, 8000]) {
      await sleep(delay, signal);
      result = await callClaudeForChunk(opts);
      if (result.ok) return result;
      if (result.error.kind !== "rate_limit") break;
    }
    return result;
  }

  if (result.error.kind === "invalid_json" || result.error.kind === "schema_violation") {
    result = await callClaudeForChunk(opts); // simple one-shot retry
    return result;
  }

  if (result.error.kind === "max_tokens") {
    // Split this chunk in half and retry once each
    const half = Math.ceil(chunk.sessions.length / 2);
    if (half === 0) return result;
    const a: Chunk = { isFirstChunk: chunk.isFirstChunk, sessions: chunk.sessions.slice(0, half) };
    const b: Chunk = { isFirstChunk: false, sessions: chunk.sessions.slice(half) };
    const [ra, rb] = await Promise.all([
      callClaudeForChunk({ ...opts, chunk: a }),
      callClaudeForChunk({ ...opts, chunk: b }),
    ]);
    if (ra.ok && rb.ok) {
      return {
        ok: true,
        value: {
          event: ra.value.event ?? rb.value.event,
          sessions: [...ra.value.sessions, ...rb.value.sessions],
          notes: [...ra.value.notes, ...rb.value.notes],
        },
      };
    }
    return result; // mixed/all-failed → bubble up
  }

  if (result.error.kind === "network") {
    result = await callClaudeForChunk(opts);
    return result;
  }

  return result;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

function mergeChunkResults(
  determ: AnalysisResult,
  chunkResults: { chunk: Chunk; result: ChunkResult }[],
): AnalysisResult {
  const sessionsByRef = new Map<number, AnalysisSession>();
  const notes: AnalysisResult["notes"] = [];
  let event: AnalysisEvent = determ.event;
  let chunksFailed = 0;
  let aiTracks = 0;

  // Seed with deterministic sessions so fallbacks are preserved
  for (const s of determ.sessions) sessionsByRef.set(s.sessionNumber, structuredCloneSession(s));

  for (const { chunk, result } of chunkResults) {
    if (!result.ok) {
      chunksFailed++;
      continue;
    }
    if (chunk.isFirstChunk && result.value.event) {
      event = result.value.event;
    }
    for (const aiSession of result.value.sessions) {
      const existing = sessionsByRef.get(aiSession.sessionNumber);
      if (!existing) {
        sessionsByRef.set(aiSession.sessionNumber, aiSession);
        aiTracks += aiSession.tracks.length;
        continue;
      }
      // Replace only the tracks at the positions covered by this AI session
      const positions = new Set(aiSession.tracks.map((t) => t.position));
      existing.tracks = existing.tracks.map((t) => {
        if (positions.has(t.position)) {
          const aiTrack = aiSession.tracks.find((x) => x.position === t.position);
          if (aiTrack) {
            aiTracks++;
            return aiTrack;
          }
        }
        return t;
      });
      // Adopt AI session-level fields only for whole-session chunks
      const isPartial = chunk.sessions.find((s) => s.sessionNumber === aiSession.sessionNumber)?.partOf;
      if (!isPartial) {
        existing.titleEn = aiSession.titleEn;
        existing.titlePt = aiSession.titlePt;
        existing.sessionDate = aiSession.sessionDate;
        existing.timePeriod = aiSession.timePeriod;
      }
    }
    notes.push(...result.value.notes);
  }

  const sessions = Array.from(sessionsByRef.values()).sort(
    (a, b) => a.sessionNumber - b.sessionNumber,
  );

  return {
    aiCoverage: {
      totalTracks: determ.aiCoverage.totalTracks,
      tracksAnalyzedByAi: aiTracks,
      tracksFromDeterministicFallback: determ.aiCoverage.totalTracks - aiTracks,
      chunks: chunkResults.length,
      chunksFailed,
    },
    event,
    sessions,
    notes,
  };
}

function structuredCloneSession(s: AnalysisSession): AnalysisSession {
  return { ...s, tracks: s.tracks.map((t) => ({ ...t, corrections: [...t.corrections] })) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-analysis.test.ts'`

Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/track-analysis.ts tests/services/track-analysis.test.ts
git commit -m "feat(import): analyzeFolder orchestrator with per-chunk fallback"
```

---

## Task 6: SSE route handler

**Why:** Exposes the orchestrator over HTTP, with auth, validation, and SSE event forwarding.

**Files:**
- Create: `src/routes/admin/import/analyze.ts`
- Modify: `src/routes/admin/index.ts` (register the route)
- Test: `tests/routes/admin/import.analyze.test.ts` (create)

- [ ] **Step 1: Write failing route test**

Create `tests/routes/admin/import.analyze.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../../../src/services/track-analysis.ts", async () => {
  return {
    analyzeFolder: vi.fn(async (_input, onProgress, _signal) => {
      onProgress({ type: "phase", phase: "scanning" });
      onProgress({ type: "phase", phase: "deterministic_parse", totalFiles: 1, totalSessions: 1 });
      onProgress({ type: "phase", phase: "ai_analysis", totalChunks: 1 });
      onProgress({ type: "chunk_progress", done: 1, total: 1 });
      return {
        aiCoverage: { totalTracks: 1, tracksAnalyzedByAi: 1, tracksFromDeterministicFallback: 0, chunks: 1, chunksFailed: 0 },
        event: { titleEn: null, titlePt: null, startDate: null, endDate: null, matchedGroupIds: [], matchedTeacherIds: [], matchedPlaceIds: [], folderConventionOk: true },
        sessions: [],
        notes: [],
      };
    }),
  };
});

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: {
      retreatGroups: { findMany: vi.fn(async () => []) },
      teachers: { findMany: vi.fn(async () => []) },
      places: { findMany: vi.fn(async () => []) },
    },
  },
}));

import { analyzeRoutes } from "../../../src/routes/admin/import/analyze.ts";

function buildApp() {
  const app = new Hono();
  // Inject a fake user middleware
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", role: "admin", email: "a@b.c" });
    await next();
  });
  app.route("/", analyzeRoutes);
  return app;
}

async function readSSE(stream: ReadableStream): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      events.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.length > 0) events.push(buffer);
  return events;
}

describe("POST /admin/import/analyze", () => {
  it("rejects payloads missing folderName with 400", async () => {
    const app = buildApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("streams the expected SSE event sequence", async () => {
    const app = buildApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderName: "x",
        files: [{ relativePath: "01_a.mp3", sizeBytes: 1 }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSSE(res.body!);
    const types = events.map((e) => /event:\s*(\S+)/.exec(e)?.[1]).filter(Boolean);
    expect(types).toEqual([
      "phase",
      "phase",
      "phase",
      "chunk_progress",
      "result",
    ]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/admin/import.analyze.test.ts'`

Expected: FAIL — route module not found.

- [ ] **Step 3: Create the route module**

Create `src/routes/admin/import/analyze.ts`:

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../../../db/index.ts";
import { retreatGroups } from "../../../db/schema/retreat-groups.ts";
import { teachers } from "../../../db/schema/teachers.ts";
import { places } from "../../../db/schema/places.ts";
import { AppError } from "../../../lib/errors.ts";
import { analyzeFolder } from "../../../services/track-analysis.ts";
import type { AuthUser } from "../../../types/index.ts";

const bodySchema = z.object({
  folderName: z.string().min(1),
  files: z
    .array(
      z.object({
        relativePath: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export const analyzeRoutes = new Hono();

analyzeRoutes.post("/", async (c) => {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) throw AppError.unauthorized("Authentication required");
  if (user.role !== "admin" && user.role !== "superadmin") {
    throw AppError.forbidden("Admin role required");
  }

  const parsed = bodySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw AppError.badRequest("Invalid payload", "VALIDATION_ERROR");
  }
  const { folderName, files } = parsed.data;

  const [knownGroupsRows, knownTeachersRows, knownPlacesRows] = await Promise.all([
    db.query.retreatGroups.findMany({ columns: { id: true, nameEn: true, namePt: true, slug: true, abbreviation: true } }),
    db.query.teachers.findMany({ columns: { id: true, name: true, abbreviation: true } }),
    db.query.places.findMany({ columns: { id: true, name: true, abbreviation: true } }),
  ]);

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    c.req.raw.signal.addEventListener("abort", onAbort);
    try {
      const result = await analyzeFolder(
        {
          folderName,
          files,
          knownGroups: knownGroupsRows.map((r) => ({
            id: r.id,
            nameEn: r.nameEn,
            namePt: r.namePt ?? r.nameEn,
            slug: r.slug,
            abbreviation: r.abbreviation ?? "",
          })),
          knownTeachers: knownTeachersRows.map((r) => ({
            id: r.id,
            name: r.name,
            abbreviation: r.abbreviation ?? "",
          })),
          knownPlaces: knownPlacesRows.map((r) => ({
            id: r.id,
            name: r.name,
            abbreviation: r.abbreviation ?? "",
          })),
        },
        async (event) => {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        },
        ac.signal,
      );
      await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: (err as Error).message }),
      });
    } finally {
      c.req.raw.signal.removeEventListener("abort", onAbort);
    }
  });
});
```

All four lookup tables (`retreat-groups`, `teachers`, `places`, `event-types`) have an `abbreviation` text column — verified.

- [ ] **Step 4: Register the route**

Edit `src/routes/admin/index.ts`. After the existing admin sub-route imports/registrations, add:

```ts
import { analyzeRoutes } from "./import/analyze.ts";
// ...
admin.route("/import/analyze", analyzeRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/admin/import.analyze.test.ts'`

Expected: PASS.

Also run the full test suite to confirm no regressions:

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'`

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/import/analyze.ts src/routes/admin/index.ts tests/routes/admin/import.analyze.test.ts
git commit -m "feat(import): SSE route POST /admin/import/analyze"
```

---

## Task 7: Frontend SSE client `analyzeFolder.ts`

**Why:** Parses the fetch response stream into typed `ProgressEvent`s the dropzone can consume.

**Files:**
- Create: `admin/src/utils/analyzeFolder.ts`

This task has no unit tests (per the agreed strategy). Manual verification is the next task.

- [ ] **Step 1: Create the client module**

Create `admin/src/utils/analyzeFolder.ts`:

```ts
// Mirrors the backend's ProgressEvent and AnalysisResult shapes. Keep in
// sync with src/services/track-analysis.ts and src/services/track-conventions.ts.

export type ProgressEvent =
  | { type: "phase"; phase: "scanning" }
  | { type: "phase"; phase: "deterministic_parse"; totalFiles: number; totalSessions: number }
  | { type: "phase"; phase: "ai_analysis"; totalChunks: number }
  | { type: "chunk_progress"; done: number; total: number }
  | { type: "chunk_failed"; chunkIndex: number; reason: string; willFallback: true };

export interface TrackCorrection {
  field: "filename" | "displayTitleEn" | "displayTitlePt";
  before: string;
  after: string;
  reason: string;
}
export interface AnalysisTrack {
  position: number;
  originalFilename: string;
  correctedFilename: string;
  displayTitleEn: string;
  displayTitlePt: string;
  corrections: TrackCorrection[];
}
export interface AnalysisSession {
  sessionNumber: number;
  titleEn: string;
  titlePt: string;
  sessionDate: string | null;
  timePeriod: "morning" | "afternoon" | "evening" | null;
  tracks: AnalysisTrack[];
}
export interface AnalysisNote {
  severity: "info" | "warning";
  message: string;
  relatedFilename?: string;
}
export interface AnalysisResult {
  aiCoverage: {
    totalTracks: number;
    tracksAnalyzedByAi: number;
    tracksFromDeterministicFallback: number;
    chunks: number;
    chunksFailed: number;
  };
  event: {
    titleEn: string | null;
    titlePt: string | null;
    startDate: string | null;
    endDate: string | null;
    matchedGroupIds: string[];
    matchedTeacherIds: string[];
    matchedPlaceIds: string[];
    folderConventionOk: boolean;
  };
  sessions: AnalysisSession[];
  notes: AnalysisNote[];
}

// Shared client-side type for files captured at drop time.
export interface ScannedFile {
  relativePath: string;
  sizeBytes: number;
  file: File;
}

export interface AnalyzeFolderParams {
  folderName: string;
  files: { relativePath: string; sizeBytes: number }[];
  onProgress: (e: ProgressEvent) => void;
  signal: AbortSignal;
  authToken: string;
  apiBase: string;
}

export async function analyzeFolderStream(params: AnalyzeFolderParams): Promise<AnalysisResult> {
  const res = await fetch(`${params.apiBase}/admin/import/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${params.authToken}`,
    },
    body: JSON.stringify({ folderName: params.folderName, files: params.files }),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`analyze request failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const eventMatch = /event:\s*(\S+)/.exec(raw);
      const dataMatch = /data:\s*(.*)/s.exec(raw);
      if (!eventMatch || !dataMatch) continue;
      const eventName = eventMatch[1];
      const data = JSON.parse(dataMatch[1]);
      if (eventName === "result") {
        result = data as AnalysisResult;
      } else if (eventName === "error") {
        throw new Error(data.message ?? "analyze stream error");
      } else {
        params.onProgress(data as ProgressEvent);
      }
    }
  }
  if (!result) throw new Error("analyze stream closed without result");
  return result;
}
```

- [ ] **Step 2: Type-check**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin/src/utils/analyzeFolder.ts
git commit -m "feat(admin): SSE client for /admin/import/analyze"
```

---

## Task 8: Refactor `TrackDropZone` to call the analyze endpoint

**Why:** Replace synchronous client-side parsing with async streaming call, add spinner overlay with progress text.

**Files:**
- Modify: `admin/src/components/TrackDropZone.tsx`

This task has no unit tests; we rely on the existing tests of pure parsing functions in `trackParser.ts` (they continue to exist; we just don't call them from the dropzone anymore).

- [ ] **Step 1: Read the current `TrackDropZone.tsx` end-to-end**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && cat admin/src/components/TrackDropZone.tsx | head -160'`

Note the current `onFolderDropped` callback signature `(meta: FolderMetadata, tracks: ParsedTrack[]) => void`. We are widening it to `(result: AnalysisResult, folderName: string) => void`.

- [ ] **Step 2: Update the component**

Replace the contents of `admin/src/components/TrackDropZone.tsx` with:

```tsx
import { useCallback, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import {
  analyzeFolderStream,
  type AnalysisResult,
  type ProgressEvent,
  type ScannedFile,
} from "../utils/analyzeFolder.ts";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "analysing"; folderName: string; totalFiles: number; totalSessions: number; chunkDone: number; chunkTotal: number };

interface Props {
  onAnalyzed: (result: AnalysisResult, files: ScannedFile[], folderName: string) => void;
  onError?: (err: Error) => void;
  authToken: string;
  apiBase: string;
  /** When set, the dropzone is in 'files already loaded' state (collapsed look). */
  fileCount?: number;
  folderName?: string | null;
}

async function walkEntry(entry: FileSystemEntry, prefix: string, acc: ScannedFile[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    acc.push({ relativePath: `${prefix}${entry.name}`, sizeBytes: file.size, file });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let entries: FileSystemEntry[];
    do {
      entries = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res));
      for (const e of entries) await walkEntry(e, `${prefix}${entry.name}/`, acc);
    } while (entries.length > 0);
  }
}

const AUDIO_RE = /\.(mp3|wav|m4a|flac|ogg)$/i;

export function TrackDropZone({ onAnalyzed, onError, authToken, apiBase, fileCount, folderName }: Props) {
  const t = useTranslate();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const handleDrop = useCallback(
    async (ev: React.DragEvent) => {
      ev.preventDefault();
      if (!ev.dataTransfer.items?.length) return;
      const items = Array.from(ev.dataTransfer.items);
      const entries = items
        .map((i) => i.webkitGetAsEntry())
        .filter((e): e is FileSystemEntry => e !== null);

      setPhase({ kind: "scanning" });
      const allFiles: ScannedFile[] = [];
      const rootName =
        entries.length === 1 && entries[0].isDirectory ? entries[0].name : "Dropped files";
      for (const entry of entries) await walkEntry(entry, "", allFiles);
      const audioFiles = allFiles.filter((f) => AUDIO_RE.test(f.file.name));
      if (audioFiles.length === 0) {
        setPhase({ kind: "idle" });
        onError?.(new Error(t("padmakara.import.noAudioFound") || "No audio files in the dropped folder"));
        return;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPhase({
        kind: "analysing",
        folderName: rootName,
        totalFiles: audioFiles.length,
        totalSessions: 0,
        chunkDone: 0,
        chunkTotal: 0,
      });

      try {
        const result = await analyzeFolderStream({
          folderName: rootName,
          files: audioFiles.map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes })),
          onProgress: (e: ProgressEvent) => {
            setPhase((prev) => {
              if (prev.kind !== "analysing") return prev;
              if (e.type === "phase" && e.phase === "deterministic_parse") {
                return { ...prev, totalSessions: e.totalSessions };
              }
              if (e.type === "phase" && e.phase === "ai_analysis") {
                return { ...prev, chunkTotal: e.totalChunks };
              }
              if (e.type === "chunk_progress") {
                return { ...prev, chunkDone: e.done, chunkTotal: e.total };
              }
              return prev;
            });
          },
          signal: ac.signal,
          authToken,
          apiBase,
        });
        setPhase({ kind: "idle" });
        onAnalyzed(result, audioFiles, rootName);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setPhase({ kind: "idle" });
          return;
        }
        setPhase({ kind: "idle" });
        onError?.(err as Error);
      }
    },
    [authToken, apiBase, onAnalyzed, onError, t],
  );

  const handleCancel = () => abortRef.current?.abort();

  // ─── Render ─────────────────────────────────────────────────────────
  if (phase.kind === "scanning") {
    return (
      <Surface>
        <p>⏳ {t("padmakara.import.scanning") || "Scanning folder…"}</p>
      </Surface>
    );
  }

  if (phase.kind === "analysing") {
    return (
      <Surface>
        <p>⏳ {phase.totalFiles} {t("padmakara.import.filesDetected") || "files detected"}, {phase.totalSessions} {t("padmakara.import.sessions") || "sessions"}</p>
        {phase.chunkTotal > 0 && (
          <p>🤖 {t("padmakara.import.aiAnalysis") || "AI analysis"}: {phase.chunkDone} / {phase.chunkTotal}</p>
        )}
        <button onClick={handleCancel}>{t("padmakara.import.cancel") || "Cancel"}</button>
      </Surface>
    );
  }

  if (fileCount && fileCount > 0) {
    return (
      <Surface compact>
        <p>{fileCount} {t("padmakara.import.filesLoaded") || "files loaded from"} {folderName ?? ""}</p>
      </Surface>
    );
  }

  return (
    <Surface
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <p>{t("padmakara.import.dropPrompt") || "Drop the event folder here"}</p>
    </Surface>
  );
}

function Surface({
  children,
  compact = false,
  onDrop,
  onDragOver,
}: {
  children: React.ReactNode;
  compact?: boolean;
  onDrop?: React.DragEventHandler;
  onDragOver?: React.DragEventHandler;
}) {
  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      style={{
        border: "2px dashed #999",
        borderRadius: 8,
        padding: compact ? 12 : 32,
        textAlign: "center",
        background: "#fafafa",
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: PASS. (Will likely fail with errors in `events.tsx` because its callback signature no longer matches — that's expected; we fix it in Task 11.)

- [ ] **Step 4: Commit (allow the events.tsx errors for now)**

If typecheck fails only inside `admin/src/resources/events.tsx`, that's fine — the next two tasks fix it.

```bash
git add admin/src/components/TrackDropZone.tsx
git commit -m "feat(admin): async TrackDropZone with SSE-streamed analysis"
```

---

## Task 9: Refactor `SessionPreview` to show corrections, notes, and fallback banner

**Why:** Displays per-track correction badges with expandable diffs, the AI notes section at the bottom, and the fallback banner when AI degraded.

**Files:**
- Modify: `admin/src/components/SessionPreview.tsx`

- [ ] **Step 1: Read the current `SessionPreview.tsx`**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && wc -l admin/src/components/SessionPreview.tsx && sed -n "1,50p" admin/src/components/SessionPreview.tsx'`

Note the props shape and how rows are rendered today so the edit preserves layout.

- [ ] **Step 2: Extend the props and types**

At the top of `admin/src/components/SessionPreview.tsx`, change the imported types and the `Props` type:

```tsx
import type { AnalysisSession, AnalysisNote, AnalysisResult } from "../utils/analyzeFolder.ts";

interface Props {
  sessions: AnalysisSession[];
  notes: AnalysisNote[];
  aiCoverage: AnalysisResult["aiCoverage"];
  onSessionTitleChange?: (sessionNumber: number, titleEn: string, titlePt: string) => void;
  onTrackUpdate?: (sessionNumber: number, position: number, patch: Partial<AnalysisSession["tracks"][number]>) => void;
  onTrackDelete?: (sessionNumber: number, position: number) => void;
  onRetryAi?: () => void;
}
```

(Keep any existing prop callbacks that are still needed for the rest of the UI — `allTeachers`, video uploads, etc. — and just add the new ones.)

- [ ] **Step 3: Render the fallback banner above the session list**

Just before the session list rendering, add:

```tsx
{aiCoverage.tracksAnalyzedByAi === 0 || aiCoverage.chunksFailed > 0 ? (
  <div
    style={{
      background: "#FFF4D6",
      border: "1px solid #E0B847",
      borderRadius: 6,
      padding: 12,
      margin: "12px 0",
    }}
    role="alert"
  >
    <strong>⚠ {t("padmakara.import.aiUnavailableTitle") || "AI analysis unavailable for some or all tracks"}</strong>
    <p style={{ margin: "8px 0" }}>
      {t("padmakara.import.aiUnavailableBody") ||
        "The grouping and titles below come from the automatic parser only. Typos or errors may slip through. If this is not urgent, we recommend retrying in a few minutes for better results. Otherwise, please review each title carefully before saving."}
    </p>
    {onRetryAi && (
      <button onClick={onRetryAi}>
        {t("padmakara.import.retryAi") || "Retry AI analysis"}
      </button>
    )}
  </div>
) : null}
```

- [ ] **Step 4: Extract a `TrackRow` subcomponent and render it for each track**

Add this component at the bottom of `SessionPreview.tsx` (outside the main component):

```tsx
import { useState } from "react";
import type { AnalysisTrack } from "../utils/analyzeFolder.ts";

function TrackRow({ track, tCorrections }: { track: AnalysisTrack; tCorrections: string }) {
  const [showDiff, setShowDiff] = useState(false);
  const hasCorrections = track.corrections.length > 0;
  return (
    <li
      style={{
        background: hasCorrections ? "#FFF8E1" : "transparent",
        padding: 8,
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {hasCorrections && <span title="Modified by AI">✨</span>}
        <span>{track.position + 1}.</span>
        <span style={{ flex: 1 }}>{track.displayTitlePt}</span>
        <code style={{ fontSize: "0.85em", color: "#666" }}>{track.correctedFilename}</code>
      </div>
      {hasCorrections && (
        <button
          onClick={() => setShowDiff((s) => !s)}
          style={{ fontSize: "0.85em", marginTop: 4, padding: "2px 6px", background: "transparent", border: "none", color: "#1565C0", cursor: "pointer" }}
        >
          {showDiff ? "▾" : "▸"} {track.corrections.length} {tCorrections}
        </button>
      )}
      {showDiff && (
        <ul style={{ fontSize: "0.85em", color: "#444", marginTop: 4, paddingLeft: 16 }}>
          {track.corrections.map((c, i) => (
            <li key={i}>
              <strong>{c.field}:</strong> "{c.before}" → "{c.after}"{" "}
              <em style={{ color: "#888" }}>({c.reason})</em>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
```

Then in the main `SessionPreview` component, where tracks are mapped, render:

```tsx
{session.tracks.map((track) => (
  <TrackRow
    key={`${session.sessionNumber}-${track.position}`}
    track={track}
    tCorrections={t("padmakara.import.corrections") || "corrections"}
  />
))}
```

(Pass the translated string in as a prop because `useTranslate` only returns from a component scope, and we don't want to call hooks inside the row map.)

- [ ] **Step 5: Render the notes section below the session list**

After the session list, before save/cancel buttons, add:

```tsx
{notes.length > 0 && (
  <section style={{ marginTop: 24 }}>
    <h4>🔍 {t("padmakara.import.aiNotes") || "AI notes"} ({notes.length})</h4>
    <ul>
      {notes.map((n, i) => (
        <li key={i} style={{ marginBottom: 8 }}>
          {n.severity === "warning" ? "⚠" : "ℹ"} {n.message}
          {n.relatedFilename && (
            <code style={{ marginLeft: 6, fontSize: "0.85em", color: "#666" }}>
              {n.relatedFilename}
            </code>
          )}
        </li>
      ))}
    </ul>
  </section>
)}
```

- [ ] **Step 6: Type-check**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: residual errors only in `events.tsx` (next task fixes it).

- [ ] **Step 7: Commit**

```bash
git add admin/src/components/SessionPreview.tsx
git commit -m "feat(admin): correction badges, AI notes section, fallback banner in SessionPreview"
```

---

## Task 10: Refactor `EventCreate.handleFolderDropped`

**Why:** Adapt the page-level state to the new shape coming out of `TrackDropZone` (an `AnalysisResult`, not `(meta, tracks)`), and wire up the retry/upload data flow.

**Files:**
- Modify: `admin/src/resources/events.tsx` (lines 1095–1188 approx)

- [ ] **Step 1: Adapt component state**

Inside `EventCreate`, replace the `parsedTracks`/`sessions`/`folderName` state with:

```tsx
const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([]);
const [folderName, setFolderName] = useState<string | null>(null);
```

Import:
```tsx
import type { AnalysisResult, ScannedFile } from "../utils/analyzeFolder.ts";
```

`ScannedFile` was exported from `analyzeFolder.ts` in Task 7 — import it from there.

- [ ] **Step 2: Rewrite `handleFolderDropped`**

Replace the `handleFolderDropped` callback with:

```tsx
const handleAnalyzed = useCallback(
  (result: AnalysisResult, files: ScannedFile[], droppedFolderName: string) => {
    setAnalysis(result);
    setScannedFiles(files);
    setFolderName(droppedFolderName);

    // Fill the form from the AI event metadata.
    setForm((prev) => ({
      ...prev,
      titleEn: prev.titleEn || result.event.titleEn || "",
      titlePt: prev.titlePt || result.event.titlePt || "",
      startDate: prev.startDate || result.event.startDate || "",
      endDate: prev.endDate || result.event.endDate || "",
    }));

    // Apply matched IDs to selected lookups if not already chosen.
    if (allTeachers.length && result.event.matchedTeacherIds.length) {
      const matches = allTeachers.filter((t) => result.event.matchedTeacherIds.includes(t.id));
      setSelectedTeachers((prev) => (prev.length === 0 ? matches : prev));
    }
    if (allGroups.length && result.event.matchedGroupIds.length) {
      const matches = allGroups.filter((g) => result.event.matchedGroupIds.includes(g.id));
      setSelectedGroups((prev) => (prev.length === 0 ? matches : prev));
    }
    if (allPlaces.length && result.event.matchedPlaceIds.length) {
      const matches = allPlaces.filter((p) => result.event.matchedPlaceIds.includes(p.id));
      setSelectedPlaces((prev) => (prev.length === 0 ? matches : prev));
    }
  },
  [allTeachers, allGroups, allPlaces],
);
```

- [ ] **Step 3: Update the `TrackDropZone` and `SessionPreview` props**

Where `TrackDropZone` is rendered, change props to:

```tsx
<TrackDropZone
  onAnalyzed={handleAnalyzed}
  onError={(err) => notify(err.message, { type: "error" })}
  authToken={authToken}
  apiBase={import.meta.env.VITE_API_URL ?? "/api"}
  fileCount={scannedFiles.length}
  folderName={folderName}
/>
```

(`authToken` comes from however the admin currently obtains the JWT — read the existing `dataProvider` setup if unclear; reuse the same retrieval.)

Where `SessionPreview` is rendered, change props to:

```tsx
{analysis && (
  <SessionPreview
    sessions={analysis.sessions}
    notes={analysis.notes}
    aiCoverage={analysis.aiCoverage}
    onRetryAi={() => {
      // Re-run analyze on the cached scannedFiles
      handleRetryAi();
    }}
    // ...keep any other existing props
  />
)}
```

Add a `handleRetryAi` callback that re-invokes `analyzeFolderStream` with the same `scannedFiles` and folder name, then calls `handleAnalyzed` again.

- [ ] **Step 4: Type-check the admin app end to end**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: PASS, no errors anywhere.

- [ ] **Step 5: Commit**

```bash
git add admin/src/resources/events.tsx admin/src/utils/analyzeFolder.ts
git commit -m "feat(admin): wire EventCreate to AI analysis result + retry"
```

---

## Task 11: Use `correctedFilename` as the S3 key in `uploadManager`

**Why:** The whole point of corrections-for-filenames is that S3 receives the corrected key.

**Files:**
- Modify: `admin/src/utils/uploadManager.ts`

- [ ] **Step 1: Read the current `uploadManager.ts` (focus on `UploadItem` and the presign call site)**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && sed -n "1,140p" admin/src/utils/uploadManager.ts'`

Identify where `item.filename` is sent to the presign endpoint. Today it's the original `file.name`; we want it to be the corrected one.

- [ ] **Step 2: Extend `UploadItem` and use `correctedFilename`**

Add to the `UploadItem` interface a new field:

```ts
export interface UploadItem {
  trackId: string;
  sessionNumber: number;
  file: File;
  filename: string;            // original (for display only)
  correctedFilename: string;   // new — used as the S3 key
  title?: string;
}
```

In the presign-call body, send `correctedFilename` as the `filename` field (the backend builds the S3 key from it via `buildTrackS3Key`).

- [ ] **Step 3: Update the call site in `events.tsx`**

Where the admin builds the `UploadItem[]` to pass to `uploadTracks`, populate `correctedFilename` from `analysis.sessions[i].tracks[j].correctedFilename`.

- [ ] **Step 4: Type-check**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/src/utils/uploadManager.ts admin/src/resources/events.tsx
git commit -m "feat(admin): use corrected filename as S3 key on upload"
```

---

## Task 12: i18n keys

**Why:** Every user-facing string above used a `t("padmakara.import.*")` key with an English fallback. Now register the real translations.

**Files:**
- Modify: `admin/src/i18n/en.ts`
- Modify: `admin/src/i18n/pt.ts`

- [ ] **Step 1: Read existing locale files to find the right spot**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && sed -n "1,30p" admin/src/i18n/en.ts admin/src/i18n/pt.ts'`

Find the `padmakara: { ... }` block in each.

- [ ] **Step 2: Add `import` namespace to `en.ts`**

Inside `padmakara: { ... }`, add:

```ts
import: {
  dropPrompt: "Drop the event folder here",
  scanning: "Scanning folder…",
  filesDetected: "files detected",
  sessions: "sessions",
  aiAnalysis: "AI analysis",
  cancel: "Cancel",
  filesLoaded: "files loaded from",
  noAudioFound: "No audio files in the dropped folder.",
  corrections: "corrections",
  aiNotes: "AI notes",
  aiUnavailableTitle: "AI analysis unavailable for some or all tracks",
  aiUnavailableBody:
    "The grouping and titles below come from the automatic parser only. Typos or errors may slip through. If this is not urgent, we recommend retrying in a few minutes for better results. Otherwise, please review each title carefully before saving.",
  retryAi: "Retry AI analysis",
},
```

- [ ] **Step 3: Add the same namespace to `pt.ts` with Portuguese translations**

```ts
import: {
  dropPrompt: "Arrasta para aqui a pasta do evento",
  scanning: "A analisar a pasta…",
  filesDetected: "ficheiros detectados",
  sessions: "sessões",
  aiAnalysis: "Análise por IA",
  cancel: "Cancelar",
  filesLoaded: "ficheiros carregados de",
  noAudioFound: "Nenhum ficheiro de áudio na pasta.",
  corrections: "correcções",
  aiNotes: "Notas da IA",
  aiUnavailableTitle: "Análise IA indisponível para alguns ou todos os tracks",
  aiUnavailableBody:
    "O agrupamento e os títulos abaixo vêm apenas do parser automático. Podem passar despercebidos erros ou typos. Se não for urgente, recomendamos tentar de novo daqui a alguns minutos. Caso contrário, revê cada título com atenção antes de gravar.",
  retryAi: "Tentar de novo a análise IA",
},
```

- [ ] **Step 4: Type-check**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/src/i18n/en.ts admin/src/i18n/pt.ts
git commit -m "i18n(admin): import flow strings (EN+PT)"
```

---

## Task 13: Manual browser verification

**Why:** Tests above cover backend logic exhaustively; UI behaviour is verified manually before merging.

**Files:** none (acceptance checklist only)

- [ ] **Step 1: Start backend + admin dev servers**

Two terminals:

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run dev'
```

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/.claude/worktrees/admin-ai-track-analysis && /Users/jeremy/.bun/bin/bun run dev:admin'
```

- [ ] **Step 2: Happy-path verification**

Sign in to the admin UI as a superadmin. Click "Create event". Drop a small test folder (≤ 10 files) with a few intentional typos in filenames (e.g., `01_introducao.mp3` instead of `01_introdução.mp3`).

Verify:
- Browser does NOT freeze during the drop.
- Spinner appears with "Scanning folder…" then "N files detected, M sessions" then "AI analysis: x / y".
- After ~5-10s the preview renders with the event form pre-filled.
- At least one track has a ✨ icon and a yellow row background.
- Clicking the "N corrections" caption expands a diff list.
- The display title in Portuguese shows correct accents (e.g., `Introdução`) while the `correctedFilename` shown next to it stays ASCII (e.g., `01_introducao.mp3`).

- [ ] **Step 3: Notes verification**

Drop a folder with at least one orphan file (a file that doesn't match the convention, e.g., `bonus.mp3` without numbering). Verify:
- An entry appears in the "AI notes" section at the bottom of the preview.
- If the note has a related filename, clicking it scrolls/highlights the track row (or omit this check if scroll-to-row wasn't implemented).

- [ ] **Step 4: Fallback verification**

Temporarily set `ANTHROPIC_API_KEY=invalid` in the dev `.env` and restart the API. Drop a folder.

Verify:
- The spinner still completes (does not hang).
- The fallback banner appears above the session list with amber styling.
- The session list still renders (with deterministic parsing only).
- The "Retry AI analysis" button re-runs the analysis (still fails, banner re-appears — expected).

Restore the valid API key after testing.

- [ ] **Step 5: Cancel verification**

Drop a large folder (~100+ files if available) and click "Cancel" during the AI analysis phase.

Verify:
- Spinner disappears immediately.
- Dropzone returns to its empty state.
- No notification appears.
- Backend log shows no error after the abort.

- [ ] **Step 6: Save and upload verification**

Drop a small folder, let the analysis complete, then click "Create event" / Save. Verify in the admin's S3 bucket (or via `aws s3 ls`) that the uploaded keys use the corrected filenames (ASCII, no accents).

- [ ] **Step 7: Final commit (if any cleanup made)**

If steps 2-6 surfaced any small fix, commit it:

```bash
git add -A
git commit -m "chore(admin): cleanup discovered during manual verification"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] All backend tests pass: `sh -c 'cd ... && bun node_modules/.bin/vitest run'`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Manual verification steps in Task 13 all checked
- [ ] No `TODO`, `FIXME`, `console.log` left in committed code: `git diff main...HEAD | grep -iE "TODO|FIXME|console\.log"` returns nothing
- [ ] Branch is clean: `git status` shows no uncommitted changes
- [ ] All commits follow the project's conventional-commit style
