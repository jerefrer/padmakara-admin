# Range-Based Session Inference — Design

**Date:** 2026-07-20
**Status:** Approved, ready for planning

## Problem

Some legacy events encode their session structure only in the Portuguese
translation filenames, as *track ranges*. The individual Tibetan/English
tracks carry no session marker at all.

The motivating event is
`KPS WF - Shantideva's Ninth Chapter Part 3 of 3 - LISBOA - OCT_2019 [TIB+ENG+POR]`:
368 audio files, of which 352 are individual tracks numbered `001`–`352` and
16 are Portuguese files covering ranges:

```
001-037 [TRAD] 6_10 - Manha.mp3
038-049 [POR]  6_10 - Tarde.mp3
050-080 [TRAD] 7_10 - Manha.mp3
081-092 [TRAD] 7_10 - Tarde.mp3
093     [TRAD] - 7_10 - Questao extra.mp3
094-128 [TRAD] 8_10 - Manha.mp3
129-143 [TRAD] 8_10 - Tarde Parte 1.mp3
129-143 [TRAD] 8_10 - Tarde Parte 2.mp3
144-187 [TRAD] 9_10 - Manha.mp3
188-201 [TRAD] 9_10 - Tarde.mp3
202-226 [TRAD] 10_10 - manha.mp3
227-237 [TRAD] 10_10 - tarde.mp3
238-271 [TRAD] 11_10 - manha.mp3
272-284 [TRAD] 11_10 - tarde.mp3
285-341 [TRAD] 12_10 - manha.mp3
342-352 [TRAD] 12_10 - tarde.mp3
```

The ranges are contiguous and cover `001`–`352` with no gaps.

### Current behaviour

Every one of the 368 files collapses into a single `unknown|unknown|` session:

- `SESSION_DATE_TOKEN` accepts `/` and `-` as numeric date separators but not
  `_`, so `6_10` does not parse as a date.
- `timePeriod` is derived only from `AM|PM`, so `Manha` / `Tarde` are ignored.
- The 352 individual tracks carry no date or period marker of any kind.

The whole grouping burden therefore falls on the AI pass in
`import-inference.ts`, whose prompt already concedes the deterministic seed
"is often wrong — it frequently dumps every file into a single session".
Asking Claude to map 352 filenames onto 16 ranges in one request is expensive,
unrepeatable, and carries a high risk of dropped or duplicated track ids.

## Goals

- Infer sessions deterministically whenever track ranges are present.
- Change nothing for events that do not use this convention.
- Surface anything ambiguous to the admin as a reviewable warning rather than
  silently guessing.

## Non-goals

- Splitting a grouped Portuguese file into per-track audio.
- Changing how the AI pass cleans titles or infers event metadata.
- Reworking language detection, which already handles `[TRAD]` / `[POR]`
  correctly.

## Approach

Teach the deterministic parser that a leading `NNN-NNN` is a *range*, and
derive sessions from those ranges. The AI pass then only cleans titles and
event metadata rather than regrouping.

Rejected alternatives:

- **Prompt the AI to understand ranges.** Flexible for odd variants, but
  non-deterministic, untestable, expensive on every import, and prone to
  dropping or duplicating track ids across 352 files.
- **Attach uncovered tracks to the nearest preceding range.** Always produces
  clean-looking output, which is precisely the problem: it hides genuine
  naming mistakes instead of reporting them.

## Design

### 1. Parser additions — `src/services/track-parser.ts`

Add one field to `ParsedTrack`:

```ts
/**
 * Set when the filename's leading number is a RANGE ("001-037"), meaning this
 * file covers tracks start..end rather than being a single track. Null for an
 * ordinary single-numbered track.
 */
trackRange: { start: number; end: number } | null;
```

Populated from a leading range `^(\d{1,4})\s*-\s*(\d{1,4})(?=\D|$)` where
`end >= start`. `trackNumber` is set to `start` so existing ordering keeps
working. The `(?=\D|$)` lookahead and the both-sides-numeric requirement keep
ordinary titles containing hyphens (`129 [ENG] WF - Textual outline`) from
matching.

Three vocabulary extensions to the existing session-marker machinery:

| Extension | Detail |
|---|---|
| Date separator | Add `_` to the numeric branch of `SESSION_DATE_TOKEN`, so `6_10` parses day-first as 6 October, matching the Portuguese convention already documented for `11/06`. |
| Period words | Accept `Manha\|Manhã\|Tarde\|Noite\|Morning\|Afternoon\|Evening` alongside `AM\|PM`, mapping to `morning` / `afternoon` / `evening`. |
| Part suffix | Accept `Parte N` alongside `part N`. |

The matched range, date and period are stripped from the display title, the
same way existing session markers already are.

`parseTrackFilename("001-037 [TRAD] 6_10 - Manha.mp3")` must keep returning
`languages: ["pt"]`, `originalLanguage: "pt"`, `isTranslation: true` — there
is an existing test asserting exactly this.

### 2. Range-based session inference — `src/services/session-ranges.ts` (new)

A new module rather than more code in `track-parser.ts`, which is already
18 KB. The logic is cohesive and independently testable.

```ts
export function inferSessionsFromRanges(
  tracks: ParsedTrack[],
): { sessions: InferredSession[]; notes: AnalysisNote[] };
```

**Activation gate.** Range mode engages only when at least one parsed track has
a non-null `trackRange`. Otherwise `inferSessions` behaves exactly as it does
today. This is what guarantees zero regression for every existing event, and it
contains the blast radius of the `_` date-separator change to batches that
actually use this convention.

**Session definers** are:

1. every track with an explicit `trackRange`; plus
2. every track carrying a session-marker date (a day, optionally with a period
   word — not a bare ISO or compact date elsewhere in the filename) whose
   `trackNumber` falls outside all explicit ranges, given an implicit range of
   `{start: n, end: n}`.

Clause 2 is what makes `093 [TRAD] - 7_10 - Questao extra.mp3` its own session
without a special case: ranges cover 1–92 and 94–352, so 93 is uncovered and
promotes itself to a definer.

**Session key** is `start-end | date | period`. Part number is deliberately
excluded, so `129-143 … Parte 1` and `129-143 … Parte 2` collapse into one
session; within it, definer tracks order by part number.

**Assignment.** Each non-definer track joins the session whose range contains
its `trackNumber`. On overlapping ranges the narrowest containing range wins.

**Leftovers.** Tracks matching no range go into a single trailing session
titled `Unassigned tracks`, accompanied by a warning note listing the
filenames.

**Notes emitted** (all `severity: "warning"` unless stated):

- tracks covered by no range, listing each filename;
- ranges that overlap without being identical;
- a range covering no individual tracks (`severity: "info"` — legitimate when
  only the grouped Portuguese audio survives for that session). The session is
  still created, holding just its definer track(s).

### 3. Wiring

`inferSessions` keeps its current signature and delegates to
`inferSessionsFromRanges` when the gate trips, so all six existing callers
(`upload.ts`, `import-inference.ts`, `track-analysis.ts`, and three migration
scripts) are unaffected. A new `inferSessionsWithNotes` export returns the
warnings for callers that want them.

**`src/routes/admin/upload.ts` — required fix.** Line 71 currently reads:

```ts
const originals = tracks.filter((t) => !t.isTranslation);
```

Range definers are `isTranslation: true`, so this discards the entire session
structure before `inferSessions` ever sees it. Change to keep definers in
session inference and out of the separate `translations` bucket, so nothing is
double-counted in the response the admin UI renders.

**`src/services/import-inference.ts`.** The seed is now correct, so add a line
to `GROUPING_SYSTEM_PROMPT` instructing Claude to trust a range-derived
grouping and confine itself to cleaning titles and event metadata. Notes from
range inference flow into the existing `notes` array already shown to the
admin.

### 4. Session titles

Keep the existing convention: `titleEn = "2019-10-06 - Morning"`. Where a
definer carries a descriptor instead of a period word, the title becomes
`"2019-10-07 - Questao extra"`, and the existing AI cleanup pass polishes and
translates it into `titleEn` / `titlePt`.

The year is not present in the range filenames. It comes from the event-level
date hint (`OCT_2019` yields month precision); the range files supply day and
month. Where no year is decodable the session date stays null and the AI pass
fills it, exactly as today.

## Expected result for the motivating event

15 sessions, 368 files placed, zero leftovers:

| Session | Tracks | Grouped PT file |
|---|---|---|
| Oct 6 — Morning | 001–037 | 1 |
| Oct 6 — Afternoon | 038–049 | 1 |
| Oct 7 — Morning | 050–080 | 1 |
| Oct 7 — Afternoon | 081–092 | 1 |
| Oct 7 — Questao extra | 093 | 1 |
| Oct 8 — Morning | 094–128 | 1 |
| Oct 8 — Afternoon | 129–143 | 2 (Parte 1, Parte 2) |
| Oct 9 — Morning | 144–187 | 1 |
| Oct 9 — Afternoon | 188–201 | 1 |
| Oct 10 — Morning | 202–226 | 1 |
| Oct 10 — Afternoon | 227–237 | 1 |
| Oct 11 — Morning | 238–271 | 1 |
| Oct 11 — Afternoon | 272–284 | 1 |
| Oct 12 — Morning | 285–341 | 1 |
| Oct 12 — Afternoon | 342–352 | 1 |

In the app, a session such as Oct 6 Morning holds 37 short Tibetan/English
tracks plus one 45-minute Portuguese track. The existing language filter means
Portuguese users see the single long file and English/Tibetan users see the
granular ones.

## Testing

- **Unit — parsing.** Range detection and its near-misses; `6_10` → 6 October;
  each period word; `Parte N`; title cleanup stripping range, date and period.
- **Unit — inference.** Definer selection including the uncovered-single-number
  promotion; identical ranges collapsing to one session; overlap resolved to
  the narrowest range; uncovered tracks producing a leftover session plus a
  warning.
- **Fixture.** All 368 real filenames from the motivating event, asserting
  exactly the 15 sessions above, correct boundaries, and every file placed
  exactly once.
- **Regression.** The existing ~100 `track-parser.test.ts` cases pass
  unmodified, demonstrating the activation gate holds.

## Risks

The `_` date separator is the riskiest edit, since underscores are common
separators in these filenames (`02_KPS`, `-21_April_AM_part_1`). Two
mitigations: the numeric branch requires digits on both sides, so `02_KPS`
cannot match; and the entire feature is gated behind the presence of an
explicit range, so no existing event's parse can change. The regression suite
is the check on both.
