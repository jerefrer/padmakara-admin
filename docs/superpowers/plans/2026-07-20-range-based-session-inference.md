# Range-Based Session Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive retreat sessions deterministically from track ranges encoded in Portuguese translation filenames (`001-037 [TRAD] 6_10 - Manha.mp3`), so events whose individual tracks carry no session marker stop collapsing into a single session.

**Architecture:** Three layers. `session-dates.ts` (new) holds the date/period parsing primitives shared by two consumers. `track-parser.ts` gains a `trackRange` field and recognises Portuguese period words. `session-ranges.ts` (new) turns ranges into sessions and is reached only when an explicit range exists in the batch, which is what guarantees no existing event's grouping changes.

**Tech Stack:** TypeScript (strict), Bun, Vitest, Hono, Zod v4.

**Spec:** `docs/superpowers/specs/2026-07-20-range-based-session-inference-design.md`

## Global Constraints

- TypeScript strict mode. No `any`. Explicit return types on all exported functions.
- Run tests with: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run <path>'` — `cd` alone is hijacked by zoxide.
- Pre-existing failures that are NOT regressions: 6 failures in `tests/routes/payment.test.ts` (env-dependent), 4 typecheck errors in `publications.ts` / `media.ts`. Ignore them; never "fix" them by editing tests.
- Existing tests in `tests/services/track-parser.test.ts` must pass **unmodified** — they are the regression gate proving the activation gate holds. Never edit an existing assertion to make a change pass.
- Imports use explicit `.ts` extensions (e.g. `from "./track-parser.ts"`), matching the codebase.
- Comments explain constraints and non-obvious reasoning only. No comments narrating what the next line does.
- Commit on `main` after each task. Do not push or deploy — the orchestrator handles that once.

---

### Task 1: Extract date/period primitives into `session-dates.ts`

Pure refactor plus three vocabulary additions. `track-parser.ts` is 18 KB and two modules now need this date logic; extracting it prevents a circular import between `track-parser.ts` and `session-ranges.ts` in Task 3.

**Files:**
- Create: `src/services/session-dates.ts`
- Modify: `src/services/track-parser.ts` (delete lines ~75–163, the "Session date parsing" block, and import from the new module instead)
- Test: `tests/services/session-dates.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SESSION_DATE_TOKEN: string` — regex source fragment matching one date token.
  - `PERIOD_WORDS: string` — regex source fragment, alternation of period words.
  - `parseSessionDateToken(token: string): { month: string; day: number; year: number | null } | null`
  - `formatSessionDate(parsed: { month: string; day: number; year: number | null }): string`
  - `normalizePeriod(word: string): string | null` — returns `"morning" | "afternoon" | "evening" | null`.
  - `extractBareSessionDate(filename: string): { date: string; descriptor: string } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/services/session-dates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseSessionDateToken,
  formatSessionDate,
  normalizePeriod,
  extractBareSessionDate,
} from "../../src/services/session-dates.ts";

describe("parseSessionDateToken", () => {
  it("parses underscore-separated numeric dates day-first", () => {
    expect(parseSessionDateToken("6_10")).toEqual({ month: "October", day: 6, year: null });
  });

  it("still parses slash and hyphen numeric dates day-first", () => {
    expect(parseSessionDateToken("11/06")).toEqual({ month: "June", day: 11, year: null });
    expect(parseSessionDateToken("11-06-2026")).toEqual({ month: "June", day: 11, year: 2026 });
  });

  it("rejects an impossible month", () => {
    expect(parseSessionDateToken("11_14")).toBeNull();
  });

  it("parses day-then-month-name", () => {
    expect(parseSessionDateToken("17 April")).toEqual({ month: "April", day: 17, year: null });
  });
});

describe("formatSessionDate", () => {
  it("returns ISO when a year is known", () => {
    expect(formatSessionDate({ month: "June", day: 11, year: 2026 })).toBe("2026-06-11");
  });

  it("returns month and day when the year is unknown", () => {
    expect(formatSessionDate({ month: "October", day: 6, year: null })).toBe("October 6");
  });
});

describe("normalizePeriod", () => {
  it("maps English and Portuguese period words", () => {
    expect(normalizePeriod("AM")).toBe("morning");
    expect(normalizePeriod("Manha")).toBe("morning");
    expect(normalizePeriod("manhã")).toBe("morning");
    expect(normalizePeriod("PM")).toBe("afternoon");
    expect(normalizePeriod("Tarde")).toBe("afternoon");
    expect(normalizePeriod("tarde")).toBe("afternoon");
    expect(normalizePeriod("Noite")).toBe("evening");
  });

  it("returns null for a non-period word", () => {
    expect(normalizePeriod("Questao")).toBeNull();
  });
});

describe("extractBareSessionDate", () => {
  it("extracts a date and the descriptive text that follows it", () => {
    expect(extractBareSessionDate("093 [TRAD] - 7_10 - Questao extra.mp3")).toEqual({
      date: "October 7",
      descriptor: "Questao extra",
    });
  });

  it("ignores filenames carrying a full ISO date", () => {
    expect(extractBareSessionDate("01 KPS [TIB] Prayer 2017-11-12.mp3")).toBeNull();
  });

  it("ignores filenames carrying a compact date", () => {
    expect(extractBareSessionDate("01-TPWR-20030614-KAR.mp3")).toBeNull();
  });

  it("returns null when there is no date at all", () => {
    expect(extractBareSessionDate("001 [TIB] Openning prayers.mp3")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-dates.test.ts'`

Expected: FAIL — cannot resolve `../../src/services/session-dates.ts`.

- [ ] **Step 3: Create `src/services/session-dates.ts`**

Move the block currently in `src/services/track-parser.ts` between the `// ─── Session date parsing ───` banner and `export function parseTrackFilename` (the `MONTH_NAMES`, `MONTH_NORMALIZE`, `MONTHS_PATTERN`, `SESSION_DATE_TOKEN`, `normalizeYear`, `parseSessionDateToken`, `formatSessionDate` definitions) into the new file, exporting what the interface block above lists. Apply these three changes while moving:

```ts
/**
 * Date and period parsing for session markers in track filenames.
 *
 * Shared by track-parser.ts (which reads markers anchored by a period word)
 * and session-ranges.ts (which reads bare dates on range-defining files).
 */

// Separators now include "_": the older Portuguese-labelled recordings write
// the day as "6_10" (6 October) rather than "6/10".
export const SESSION_DATE_TOKEN =
  `(?:\\d{1,2}[/_-]\\d{1,2}(?:[/_-]\\d{2,4})?`
  + `|\\d{1,2}(?:st|nd|rd|th)?[\\s_-]+(?:${MONTHS_PATTERN})`
  + `|(?:${MONTHS_PATTERN})[\\s_-]+\\d{1,2}(?:st|nd|rd|th)?)`;

// Session period words, English and Portuguese.
export const PERIOD_WORDS = "AM|PM|Manha|Manhã|Morning|Tarde|Afternoon|Noite|Evening";

const PERIOD_MAP: Record<string, string> = {
  am: "morning", manha: "morning", "manhã": "morning", morning: "morning",
  pm: "afternoon", tarde: "afternoon", afternoon: "afternoon",
  noite: "evening", evening: "evening",
};

export function normalizePeriod(word: string): string | null {
  return PERIOD_MAP[word.toLowerCase()] ?? null;
}
```

In `parseSessionDateToken`, widen the numeric branch separator to match:

```ts
  const numeric = t.match(/^(\d{1,2})[/_-](\d{1,2})(?:[/_-](\d{2,4}))?$/);
```

Then add the bare-date extractor:

```ts
/**
 * Extract a session date that is NOT anchored by a period word, plus whatever
 * descriptive text follows it — e.g. "093 [TRAD] - 7_10 - Questao extra".
 *
 * Deliberately NOT used by parseTrackFilename. Without a period word to anchor
 * on, this pattern is loose enough to read "-11-12" out of the middle of an
 * ISO date, so the two guards below bail out on any filename that already
 * carries a full date. Only session-ranges.ts calls it, and only for tracks
 * left uncovered in range mode, so ordinary events never reach it.
 */
export function extractBareSessionDate(
  filename: string,
): { date: string; descriptor: string } | null {
  const baseName = filename.replace(/\.(mp3|wav|m4a|flac|ogg|mpeg)$/i, "");
  if (/\d{4}-\d{2}-\d{2}/.test(baseName)) return null;
  if (/(?:^|\D)\d{8}(?:\D|$)/.test(baseName)) return null;

  const m = baseName.match(
    new RegExp(`[\\s_-]+(${SESSION_DATE_TOKEN})(?:[\\s_-]+(.*))?$`, "i"),
  );
  if (!m) return null;
  const parsed = parseSessionDateToken(m[1]!);
  if (!parsed) return null;
  return {
    date: formatSessionDate(parsed),
    descriptor: (m[2] ?? "").replace(/[\s_-]+$/, "").trim(),
  };
}
```

- [ ] **Step 4: Update `src/services/track-parser.ts` to import from the new module**

Delete the moved block. Add at the top of the file:

```ts
import {
  SESSION_DATE_TOKEN,
  PERIOD_WORDS,
  parseSessionDateToken,
  formatSessionDate,
  normalizePeriod,
} from "./session-dates.ts";
```

Then widen the two session-marker regexes to accept period words and `Parte N`, replacing the `(AM|PM)` groups and the `part` literal:

```ts
  const parenSession = baseName.match(
    new RegExp(`\\(\\s*(${SESSION_DATE_TOKEN})[\\s_-]+(${PERIOD_WORDS})(?:[\\s_-]+part(?:e)?[\\s_-]*(\\d+)[^)]*)?\\s*\\)`, "i"),
  );
  const trailingSession = !parenSession
    ? baseName.match(
        new RegExp(`[\\s_-]+(${SESSION_DATE_TOKEN})[\\s_-]+(${PERIOD_WORDS})(?:[\\s_-]+part(?:e)?[\\s_-]*(\\d+)\\w*)?$`, "i"),
      )
    : null;
```

And replace the AM/PM ternary with the shared mapper:

```ts
      timePeriod = normalizePeriod(sessMatch[2]!);
```

**Do NOT touch** the trailing-marker cleanup `title.replace(/\s*-?\s*\b(AM|PM)\b\s*$/i, "")`. Widening it to `PERIOD_WORDS` would corrupt legitimate titles — `272 WF Summary of morning.mp3` would become `Summary of`. The full-marker removal via `sessionMarker` already handles the range files.

- [ ] **Step 5: Run the new tests and the full parser regression suite**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-dates.test.ts tests/services/track-parser.test.ts tests/services/track-analysis.test.ts tests/services/track-filename.test.ts'`

Expected: PASS, all files. If any pre-existing `track-parser.test.ts` case now fails, the regex widening was too aggressive — fix the regex, never the test.

- [ ] **Step 6: Commit**

```bash
git add src/services/session-dates.ts src/services/track-parser.ts tests/services/session-dates.test.ts
git commit -m "refactor(parser): extract session date primitives, add PT period words

Moves date parsing out of track-parser.ts into session-dates.ts so
session-ranges.ts can share it without a circular import. Adds '_' as a
numeric date separator (6_10 = 6 October) and Portuguese period words
(Manha/Tarde/Noite) alongside AM/PM."
```

---

### Task 2: Add `trackRange` to the parser

**Files:**
- Modify: `src/services/track-parser.ts`
- Test: `tests/services/track-parser-ranges.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly.
- Produces: `ParsedTrack.trackRange: { start: number; end: number } | null` — non-null only when the filename starts with `NNN-NNN`. `trackNumber` equals `trackRange.start` in that case.

- [ ] **Step 1: Write the failing test**

Create `tests/services/track-parser-ranges.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTrackFilename } from "../../src/services/track-parser.ts";

describe("parseTrackFilename - track ranges", () => {
  it("detects a leading NNN-NNN range", () => {
    const r = parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3");
    expect(r.trackRange).toEqual({ start: 1, end: 37 });
    expect(r.trackNumber).toBe(1);
    expect(r.date).toBe("October 6");
    expect(r.timePeriod).toBe("morning");
  });

  it("reduces the title to the period word once range and marker are stripped", () => {
    expect(parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3").title).toBe("Manha");
    expect(parseTrackFilename("129-143 [TRAD] 8_10 - Tarde Parte 1.mp3").title).toBe("Tarde");
  });

  it("detects a three-digit range with a Portuguese part suffix", () => {
    const r = parseTrackFilename("129-143 [TRAD] 8_10 - Tarde Parte 1.mp3");
    expect(r.trackRange).toEqual({ start: 129, end: 143 });
    expect(r.timePeriod).toBe("afternoon");
    expect(r.partNumber).toBe(1);
  });

  it("keeps the [TRAD] language detection intact", () => {
    const r = parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3");
    expect(r.languages).toEqual(["pt"]);
    expect(r.originalLanguage).toBe("pt");
    expect(r.isTranslation).toBe(true);
  });

  it("returns null for an ordinary single-numbered track", () => {
    expect(parseTrackFilename("001 [TIB] Openning prayers.mp3").trackRange).toBeNull();
  });

  it("does not treat a speaker abbreviation after a hyphen as a range", () => {
    expect(parseTrackFilename("01-TPWR-20030614-KAR.mp3").trackRange).toBeNull();
    expect(parseTrackFilename("01-KNP - Questions (open floor).mp3").trackRange).toBeNull();
  });

  it("does not treat an ISO date as a range", () => {
    expect(parseTrackFilename("2019-10-06 - JKR Teaching.mp3").trackRange).toBeNull();
  });
});
```

Why `"Manha"` and not `""`: once the range, the `[TRAD]` tag, the date and the period are stripped, nothing descriptive remains, and the parser's existing "empty title falls back to baseName" branch would otherwise put the entire raw filename in the title. Step 4 below adds a narrower fallback so a range definer degrades to its period word instead. The AI cleanup pass later turns `Manha` into `Manhã`.

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-parser-ranges.test.ts'`

Expected: FAIL — `trackRange` is not a property of the result.

- [ ] **Step 3: Add the field to `ParsedTrack`**

```ts
export interface ParsedTrack {
  trackNumber: number;
  /**
   * Set when the filename's leading number is a RANGE ("001-037"), meaning the
   * file covers tracks start..end rather than being a single track. Null for an
   * ordinary track. When set, trackNumber equals start.
   */
  trackRange: { start: number; end: number } | null;
  speaker: string | null;
  // ...rest unchanged
}
```

- [ ] **Step 4: Detect the range in `parseTrackFilename`**

Declare alongside the other locals:

```ts
  let trackRange: { start: number; end: number } | null = null;
```

Immediately after the existing `numMatch` block, add:

```ts
  // A leading "NNN-NNN" is a track RANGE. Capped at three digits on both sides
  // so an ISO date ("2019-10-06") or a year range can never match, and both
  // sides must be numeric so "01-TPWR" stays a speaker abbreviation.
  const rangeMatch = baseName.match(/^(\d{1,3})\s*-\s*(\d{1,3})(?=\D|$)/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]!, 10);
    const end = parseInt(rangeMatch[2]!, 10);
    if (end >= start) {
      trackRange = { start, end };
      trackNumber = start;
    }
  }
```

In the title cleanup chain, strip the range **before** the generic leading-number strip:

```ts
  title = baseName
    .replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, "")
    .replace(/^\d{1,3}\s*-\s*\d{1,3}[_\s-]+/, "")
    .replace(/^\d+[_\s-]+/, "");
```

Two fixes to the marker cleanup, in the block that currently reads
`if (sessionMarker) { title = title.replace(sessionMarker, ""); }`:

```ts
  if (sessionMarker) {
    title = title.replace(sessionMarker, "");
    // sessionMarker was captured from baseName and may carry a leading
    // separator that the bracket strip above already consumed, in which case
    // the exact-string replace misses. Retry without it.
    title = title.replace(sessionMarker.replace(/^[\s_-]+/, ""), "");
  }
```

Then, just before the existing `if (!title) { title = baseName; }` fallback, add a
narrower one so a range definer degrades to its period word rather than to the
whole raw filename:

```ts
  // A range definer ("001-037 [TRAD] 6_10 - Manha") is nothing but markers, so
  // it cleans to empty. Its period word is a far better display title than the
  // raw filename the generic fallback below would use.
  if (!title.trim() && trackRange && sessMatch?.[2]) {
    title = sessMatch[2];
  }
```

Add `trackRange` to the returned object.

- [ ] **Step 5: Run tests**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/track-parser-ranges.test.ts tests/services/track-parser.test.ts tests/services/track-filename.test.ts tests/services/track-analysis.test.ts'`

Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/services/track-parser.ts tests/services/track-parser-ranges.test.ts
git commit -m "feat(parser): detect leading NNN-NNN track ranges"
```

---

### Task 3: Range-based session inference

**Files:**
- Create: `src/services/session-ranges.ts`
- Test: `tests/services/session-ranges.test.ts`

**Interfaces:**
- Consumes: `ParsedTrack`, `InferredSession` (types) from `track-parser.ts`; `extractBareSessionDate` from `session-dates.ts`; `AnalysisNote` from `track-conventions.ts`.
- Produces:
  - `hasTrackRanges(tracks: ParsedTrack[]): boolean`
  - `inferSessionsFromRanges(tracks: ParsedTrack[]): { sessions: InferredSession[]; notes: AnalysisNote[] }`

Import `ParsedTrack` and `InferredSession` with `import type` so no runtime cycle forms with Task 4's wiring.

- [ ] **Step 1: Write the failing test**

Create `tests/services/session-ranges.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTrackFilename } from "../../src/services/track-parser.ts";
import { hasTrackRanges, inferSessionsFromRanges } from "../../src/services/session-ranges.ts";

const parse = (names: string[]) => names.map(parseTrackFilename);

describe("hasTrackRanges", () => {
  it("is true when any track carries an explicit range", () => {
    expect(hasTrackRanges(parse(["001-037 [TRAD] 6_10 - Manha.mp3"]))).toBe(true);
  });

  it("is false for ordinary tracks", () => {
    expect(hasTrackRanges(parse(["001 JKR - Track-(17 April AM).mp3"]))).toBe(false);
  });
});

describe("inferSessionsFromRanges", () => {
  it("assigns individual tracks to the range that contains them", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "003-004 [TRAD] 6_10 - Tarde.mp3",
      "001 [TIB] Prayers.mp3",
      "002 [ENG] Teaching.mp3",
      "003 [TIB] Afternoon prayers.mp3",
      "004 [ENG] Afternoon teaching.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.titleEn).toBe("October 6 - Morning");
    expect(sessions[0]!.tracks.map((t) => t.originalFilename)).toEqual([
      "001 [TIB] Prayers.mp3",
      "002 [ENG] Teaching.mp3",
      "001-002 [TRAD] 6_10 - Manha.mp3",
    ]);
    expect(sessions[1]!.titleEn).toBe("October 6 - Afternoon");
    expect(sessions[1]!.tracks).toHaveLength(3);
  });

  it("collapses two files sharing one range into a single session, ordered by part", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "129-130 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 2.mp3",
      "129 [ENG] Teaching.mp3",
      "130 [ENG] Questions.mp3",
    ]));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks.map((t) => t.originalFilename)).toEqual([
      "129 [ENG] Teaching.mp3",
      "130 [ENG] Questions.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-130 [TRAD] 8_10 - Tarde Parte 2.mp3",
    ]);
  });

  it("promotes a dated track outside every range into its own session", () => {
    const { sessions } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 7_10 - Tarde.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
      "003 [TRAD] - 7_10 - Questao extra.mp3",
      "003 [ENG] WF - Extra question.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.titleEn).toBe("October 7 - Questao extra");
    expect(sessions[1]!.tracks.map((t) => t.originalFilename)).toEqual([
      "003 [ENG] WF - Extra question.mp3",
      "003 [TRAD] - 7_10 - Questao extra.mp3",
    ]);
  });

  it("puts uncovered tracks in a trailing session and warns", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "009 [ENG] Orphan.mp3",
    ]));

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.titleEn).toBe("Unassigned tracks");
    expect(sessions[1]!.tracks.map((t) => t.originalFilename)).toEqual(["009 [ENG] Orphan.mp3"]);
    const warning = notes.find((n) => n.severity === "warning");
    expect(warning?.message).toContain("009 [ENG] Orphan.mp3");
  });

  it("assigns an overlapped track to the narrower range and warns", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-010 [TRAD] 6_10 - Manha.mp3",
      "005-006 [TRAD] 6_10 - Tarde.mp3",
      "005 [ENG] Contested.mp3",
    ]));

    const narrow = sessions.find((s) => s.titleEn === "October 6 - Afternoon");
    expect(narrow!.tracks.map((t) => t.originalFilename)).toContain("005 [ENG] Contested.mp3");
    expect(notes.some((n) => n.severity === "warning" && n.message.includes("overlap"))).toBe(true);
  });

  it("notes a range with no individual tracks but still creates its session", () => {
    const { sessions, notes } = inferSessionsFromRanges(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
    ]));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tracks).toHaveLength(1);
    expect(notes.some((n) => n.severity === "info")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-ranges.test.ts'`

Expected: FAIL — cannot resolve `../../src/services/session-ranges.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/services/session-ranges.ts`:

```ts
/**
 * Range-based session inference.
 *
 * Some legacy events encode their session structure only in the Portuguese
 * translation filenames, as track ranges:
 *
 *   001-037 [TRAD] 6_10 - Manha.mp3   → tracks 1..37, 6 October, morning
 *
 * The individual Tibetan/English tracks carry no session marker at all, so
 * they can only be placed by number. This module turns those ranges into
 * sessions and assigns every other track to the range containing it.
 *
 * Reached only when at least one file carries an explicit range, which is what
 * keeps every other event's grouping unchanged.
 */
import type { ParsedTrack, InferredSession } from "./track-parser.ts";
import type { AnalysisNote } from "./track-conventions.ts";
import { extractBareSessionDate } from "./session-dates.ts";

interface Definer {
  start: number;
  end: number;
  date: string | null;
  timePeriod: string | null;
  descriptor: string | null;
  tracks: ParsedTrack[];
}

/** True when at least one track carries an explicit "NNN-NNN" range. */
export function hasTrackRanges(tracks: ParsedTrack[]): boolean {
  return tracks.some((t) => t.trackRange !== null);
}

export function inferSessionsFromRanges(
  tracks: ParsedTrack[],
): { sessions: InferredSession[]; notes: AnalysisNote[] } {
  const notes: AnalysisNote[] = [];
  const ranged = tracks.filter((t) => t.trackRange !== null);
  const others = tracks.filter((t) => t.trackRange === null);

  const inExplicitRange = (n: number): boolean =>
    ranged.some((t) => n >= t.trackRange!.start && n <= t.trackRange!.end);

  // Keyed WITHOUT part number, so "Parte 1"/"Parte 2" of one range collapse
  // into a single session instead of splitting it.
  const definers = new Map<string, Definer>();
  const addDefiner = (
    track: ParsedTrack,
    start: number,
    end: number,
    date: string | null,
    timePeriod: string | null,
    descriptor: string | null,
  ): void => {
    const key = `${start}-${end}|${date ?? ""}|${timePeriod ?? ""}`;
    const existing = definers.get(key);
    if (existing) {
      existing.tracks.push(track);
      return;
    }
    definers.set(key, { start, end, date, timePeriod, descriptor, tracks: [track] });
  };

  for (const t of ranged) {
    addDefiner(t, t.trackRange!.start, t.trackRange!.end, t.date, t.timePeriod, null);
  }

  // A dated track sitting outside every explicit range defines its own
  // single-track session, e.g. "093 [TRAD] - 7_10 - Questao extra".
  const plain: ParsedTrack[] = [];
  for (const t of others) {
    if (t.trackNumber > 0 && !inExplicitRange(t.trackNumber)) {
      const bare = extractBareSessionDate(t.originalFilename);
      if (bare) {
        addDefiner(t, t.trackNumber, t.trackNumber, bare.date, null, bare.descriptor || null);
        continue;
      }
    }
    plain.push(t);
  }

  const defs = [...definers.values()];

  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i]!;
      const b = defs[j]!;
      const overlaps = a.start <= b.end && b.start <= a.end;
      const identical = a.start === b.start && a.end === b.end;
      if (overlaps && !identical) {
        notes.push({
          severity: "warning",
          message:
            `Track ranges ${a.start}-${a.end} and ${b.start}-${b.end} overlap. `
            + `Tracks in the overlap were assigned to the narrower range.`,
        });
      }
    }
  }

  const assigned = new Map<Definer, ParsedTrack[]>(defs.map((d) => [d, []]));
  const uncovered: ParsedTrack[] = [];
  for (const t of plain) {
    const candidates = defs.filter((d) => t.trackNumber >= d.start && t.trackNumber <= d.end);
    if (candidates.length === 0) {
      uncovered.push(t);
      continue;
    }
    candidates.sort((a, b) => a.end - a.start - (b.end - b.start));
    assigned.get(candidates[0]!)!.push(t);
  }

  if (uncovered.length > 0) {
    notes.push({
      severity: "warning",
      message:
        `${uncovered.length} track(s) fall outside every track range and were placed in an `
        + `"Unassigned tracks" session: ${uncovered.map((t) => t.originalFilename).join(", ")}`,
    });
  }

  for (const d of defs) {
    if (assigned.get(d)!.length === 0) {
      notes.push({
        severity: "info",
        message:
          `Range ${d.start}-${d.end} matched no individual tracks; its session contains `
          + `only the grouped recording.`,
      });
    }
  }

  defs.sort((a, b) => a.start - b.start || a.end - b.end);

  const sessions: InferredSession[] = [];
  let sessionNumber = 1;
  for (const d of defs) {
    const definerTracks = [...d.tracks].sort(
      (a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0),
    );
    const members = [...assigned.get(d)!].sort((a, b) => a.trackNumber - b.trackNumber);
    sessions.push({
      sessionNumber,
      date: d.date,
      timePeriod: d.timePeriod,
      partNumber: null,
      titleEn: buildTitle(d, sessionNumber),
      tracks: [...members, ...definerTracks],
    });
    sessionNumber++;
  }

  if (uncovered.length > 0) {
    sessions.push({
      sessionNumber,
      date: null,
      timePeriod: null,
      partNumber: null,
      titleEn: "Unassigned tracks",
      tracks: [...uncovered].sort((a, b) => a.trackNumber - b.trackNumber),
    });
  }

  return { sessions, notes };
}

function buildTitle(d: Definer, sessionNumber: number): string {
  const periodLabel =
    d.timePeriod === "morning" ? "Morning"
    : d.timePeriod === "afternoon" ? "Afternoon"
    : d.timePeriod === "evening" ? "Evening"
    : null;
  const suffix = periodLabel ?? d.descriptor;
  if (d.date && suffix) return `${d.date} - ${suffix}`;
  if (d.date) return d.date;
  if (suffix) return suffix;
  return `Session ${sessionNumber}`;
}
```

- [ ] **Step 4: Run tests**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-ranges.test.ts'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/session-ranges.ts tests/services/session-ranges.test.ts
git commit -m "feat(import): infer sessions from track ranges"
```

---

### Task 4: Wire range mode into `inferSessions`

**Files:**
- Modify: `src/services/track-parser.ts`
- Test: `tests/services/session-ranges.test.ts` (append)

**Interfaces:**
- Consumes: `hasTrackRanges`, `inferSessionsFromRanges` from Task 3.
- Produces:
  - `inferSessions(tracks: ParsedTrack[]): InferredSession[]` — unchanged signature, six existing callers unaffected.
  - `inferSessionsWithNotes(tracks: ParsedTrack[]): { sessions: InferredSession[]; notes: AnalysisNote[] }`

- [ ] **Step 1: Write the failing test**

Append to `tests/services/session-ranges.test.ts`:

```ts
import { inferSessions, inferSessionsWithNotes } from "../../src/services/track-parser.ts";

describe("inferSessions activation gate", () => {
  it("uses range mode when a range is present", () => {
    const sessions = inferSessions(parse([
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.titleEn).toBe("October 6 - Morning");
  });

  it("falls back to date grouping when no range is present", () => {
    const sessions = inferSessions(parse([
      "001 JKR - Track 1-(17 April AM).mp3",
      "002 JKR - Track 2-(17 April AM).mp3",
      "003 JKR - Track 3-(17 April PM).mp3",
    ]));
    expect(sessions).toHaveLength(2);
  });

  it("returns no notes in date mode", () => {
    const { notes } = inferSessionsWithNotes(parse([
      "001 JKR - Track 1-(17 April AM).mp3",
    ]));
    expect(notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-ranges.test.ts'`

Expected: FAIL — `inferSessionsWithNotes` is not exported.

- [ ] **Step 3: Rename the existing function and add the wiring**

In `src/services/track-parser.ts`, rename the existing `export function inferSessions` to a private `function inferSessionsByDate` (body unchanged), then add:

```ts
import { hasTrackRanges, inferSessionsFromRanges } from "./session-ranges.ts";
import type { AnalysisNote } from "./track-conventions.ts";

/**
 * Group parsed tracks into sessions, with any warnings the grouping produced.
 *
 * Range mode engages only when a file carries an explicit "NNN-NNN" range;
 * every other event takes the original date-based path unchanged.
 */
export function inferSessionsWithNotes(
  tracks: ParsedTrack[],
): { sessions: InferredSession[]; notes: AnalysisNote[] } {
  if (hasTrackRanges(tracks)) return inferSessionsFromRanges(tracks);
  return { sessions: inferSessionsByDate(tracks), notes: [] };
}

export function inferSessions(tracks: ParsedTrack[]): InferredSession[] {
  return inferSessionsWithNotes(tracks).sessions;
}
```

- [ ] **Step 4: Run the full service suite**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/'`

Expected: PASS. `track-parser.test.ts`, `track-analysis.test.ts`, `import-inference.test.ts` must all be green.

- [ ] **Step 5: Commit**

```bash
git add src/services/track-parser.ts tests/services/session-ranges.test.ts
git commit -m "feat(import): route inferSessions through range mode when ranges exist"
```

---

### Task 5: Stop `upload.ts` discarding range definers

Range definers are `isTranslation: true`, so the existing filter throws away the only session information this kind of event has, before `inferSessions` ever sees it.

**Files:**
- Modify: `src/routes/admin/upload.ts:70-73`
- Test: `tests/services/admin-track-parser.test.ts` (append) — verify the file's existing style first and follow it.

**Interfaces:**
- Consumes: `ParsedTrack.trackRange` from Task 2.
- Produces: no new exports. The `POST /api/admin/upload/infer-sessions` response keys (`sessions`, `translations`, `totalTracks`, `originalTracks`, `translationTracks`) are unchanged; only which tracks land in `sessions` vs `translations` changes.

- [ ] **Step 1: Write the failing test**

Append to `tests/services/admin-track-parser.test.ts`:

```ts
describe("infer-sessions track partitioning", () => {
  it("keeps range definers in session inference, not the translations bucket", () => {
    const filenames = [
      "001-002 [TRAD] 6_10 - Manha.mp3",
      "001 [ENG] Teaching.mp3",
      "002 [ENG] Questions.mp3",
      "001 TRAD - Ensinamento.mp3",
    ];
    const tracks = filenames.map(parseTrackFilename);
    const forSessions = tracks.filter((t) => !t.isTranslation || t.trackRange !== null);
    const translations = tracks.filter((t) => t.isTranslation && t.trackRange === null);

    expect(forSessions.map((t) => t.originalFilename)).toContain("001-002 [TRAD] 6_10 - Manha.mp3");
    expect(translations.map((t) => t.originalFilename)).toEqual(["001 TRAD - Ensinamento.mp3"]);
    expect(forSessions.length + translations.length).toBe(tracks.length);
  });
});
```

Add `parseTrackFilename` to the file's existing imports if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/admin-track-parser.test.ts'`

Expected: FAIL — `trackRange` undefined, or the partition assertion fails.

- [ ] **Step 3: Fix the route**

Replace lines 70–73 of `src/routes/admin/upload.ts`:

```ts
  const tracks = filenames.map(parseTrackFilename);
  // Range-defining files are translations, but they carry the ONLY session
  // information some legacy events have — keep them in session inference and
  // out of the translations bucket so neither list double-counts them.
  const originals = tracks.filter((t) => !t.isTranslation || t.trackRange !== null);
  const translations = tracks.filter((t) => t.isTranslation && t.trackRange === null);
  const sessions = inferSessions(originals);
```

- [ ] **Step 4: Run tests**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/ tests/routes/'`

Expected: PASS except the 6 known `payment.test.ts` failures.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/upload.ts tests/services/admin-track-parser.test.ts
git commit -m "fix(admin): keep range-defining translations in session inference

The infer-sessions route filtered out every isTranslation track before
grouping, which discarded the range files that carry the only session
structure some legacy events have."
```

---

### Task 6: Tell the AI pass to trust a range-derived seed

**Files:**
- Modify: `src/services/import-inference.ts` (the `GROUPING_SYSTEM_PROMPT` constant, and the `inferSessions` call around line 399)

**Interfaces:**
- Consumes: `inferSessionsWithNotes` from Task 4.
- Produces: no new exports.

- [ ] **Step 1: Add the prompt rule**

In `GROUPING_SYSTEM_PROMPT`, immediately after the line beginning `- Every audio file id must appear exactly once`, insert:

```
- Some events encode sessions as track ranges in the translation filenames (e.g. "001-037 [TRAD] 6_10 - Manha.mp3" covers tracks 1 to 37). When the first-pass grouping already splits files into several dated sessions, it was derived from those ranges and is RELIABLE — keep its grouping exactly as given and only clean the titles.
```

- [ ] **Step 2: Surface the range warnings**

Change the seed call around line 399 from `inferSessions(...)` to `inferSessionsWithNotes(...)`, taking `sessions` for the seed and appending `notes` to the notes already returned to the admin. Follow the file's existing note-accumulation pattern — read the surrounding function before editing and match how it builds its notes array.

- [ ] **Step 3: Run tests**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/import-inference.test.ts'`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/import-inference.ts
git commit -m "feat(import): trust range-derived session seed in the AI pass"
```

---

### Task 7: End-to-end fixture over the real 368-file event

**Files:**
- Read: `tests/fixtures/shantideva-oct-2019-filenames.json` (already committed, 368 entries)
- Test: `tests/services/session-ranges-fixture.test.ts`

**Interfaces:**
- Consumes: `parseTrackFilename`, `inferSessionsWithNotes`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `tests/services/session-ranges-fixture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import filenames from "../fixtures/shantideva-oct-2019-filenames.json";
import { parseTrackFilename, inferSessionsWithNotes } from "../../src/services/track-parser.ts";

describe("Shantideva Oct 2019 - range-based session inference", () => {
  const tracks = (filenames as string[]).map(parseTrackFilename);
  const { sessions, notes } = inferSessionsWithNotes(tracks);

  it("reads all 368 files", () => {
    expect(filenames).toHaveLength(368);
  });

  it("produces 15 sessions", () => {
    expect(sessions).toHaveLength(15);
  });

  it("places every file exactly once", () => {
    const placed = sessions.flatMap((s) => s.tracks.map((t) => t.originalFilename));
    expect(placed).toHaveLength(368);
    expect(new Set(placed).size).toBe(368);
  });

  it("leaves no track unassigned", () => {
    expect(sessions.some((s) => s.titleEn === "Unassigned tracks")).toBe(false);
  });

  it("derives the expected session titles in order", () => {
    expect(sessions.map((s) => s.titleEn)).toEqual([
      "October 6 - Morning",
      "October 6 - Afternoon",
      "October 7 - Morning",
      "October 7 - Afternoon",
      "October 7 - Questao extra",
      "October 8 - Morning",
      "October 8 - Afternoon",
      "October 9 - Morning",
      "October 9 - Afternoon",
      "October 10 - Morning",
      "October 10 - Afternoon",
      "October 11 - Morning",
      "October 11 - Afternoon",
      "October 12 - Morning",
      "October 12 - Afternoon",
    ]);
  });

  it("gives the first session tracks 001-037 plus its grouped Portuguese file", () => {
    expect(sessions[0]!.tracks).toHaveLength(38);
    expect(sessions[0]!.tracks.at(-1)!.originalFilename).toBe("001-037 [TRAD] 6_10 - Manha.mp3");
  });

  it("collapses the two Parte files of 8 October afternoon into one session", () => {
    const s = sessions.find((x) => x.titleEn === "October 8 - Afternoon")!;
    const definers = s.tracks.filter((t) => t.trackRange !== null);
    expect(definers.map((t) => t.originalFilename)).toEqual([
      "129-143 [TRAD] 8_10 - Tarde Parte 1.mp3",
      "129-143 [TRAD] 8_10 - Tarde Parte 2.mp3",
    ]);
    expect(s.tracks).toHaveLength(17);
  });

  it("gives the extra-question session exactly its two files", () => {
    const s = sessions.find((x) => x.titleEn === "October 7 - Questao extra")!;
    expect(s.tracks.map((t) => t.originalFilename).sort()).toEqual([
      "093 [ENG] WF - Extra question.mp3",
      "093 [TRAD] - 7_10 - Questao extra.mp3",
    ]);
  });

  it("emits no warnings", () => {
    expect(notes.filter((n) => n.severity === "warning")).toEqual([]);
  });
});
```

If `tsconfig.json` lacks `resolveJsonModule`, import the fixture with
`import { readFileSync } from "node:fs"` instead of a JSON import — check before assuming.

- [ ] **Step 2: Run the test**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/session-ranges-fixture.test.ts'`

Expected: PASS. Any mismatch here is a real defect in Tasks 1–4 — fix the implementation, not the expectations. The 15 titles and the 38/17/2 track counts were derived from the actual file listing.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'`
Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun run typecheck'`

Expected: only the 6 known `payment.test.ts` failures and the 4 known `publications.ts`/`media.ts` typecheck errors.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/shantideva-oct-2019-filenames.json tests/services/session-ranges-fixture.test.ts
git commit -m "test(import): end-to-end fixture for the Shantideva Oct 2019 event"
```
