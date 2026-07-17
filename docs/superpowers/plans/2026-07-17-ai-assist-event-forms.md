# AI Assist on Both Event Forms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the event edit form an AI-instruction panel at parity with the create form, and expand AI capabilities on both forms to session titles and event text/date fields — all non-destructive with a review-then-apply gate.

**Architecture:** Extract the AI logic from the two duplicate backend handlers into one shared service (`src/services/ai-assist.ts`); both `rename-tracks` routes delegate to it. Extract the AI textarea from `SessionTrackTable` into a standalone `AiAssistPanel` component rendered by both `EventCreate` and `EventEdit`. The panel fetches suggestions, shows an old→new diff, and on confirm hands a structured result to the host, which applies it through its existing state/persistence paths.

**Tech Stack:** Hono + Bun + Drizzle + Zod v4 + Vitest (backend); React 18 + MUI + react-admin `useTranslate` + Vite (admin UI); Anthropic SDK (`claude-haiku-4-5-20251001`).

## Global Constraints

- Backend tests are mandatory (see `padmakara-api/CLAUDE.md`); use Vitest with `vi.mock("../../../src/db/index.ts")` and the `@anthropic-ai/sdk` mock pattern already in `tests/routes/admin/rename-tracks.test.ts`.
- Run tests via: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run <path>'` (zoxide hijacks `cd`; never use `SHELL=`).
- Zod v4: `import { z } from "zod"`. Errors handled by `errorHandler` → 400 `VALIDATION_ERROR`.
- Model/params are fixed and identical on both forms: `claude-haiku-4-5-20251001`, `max_tokens: 4096`, no temperature.
- Admin i18n is **TypeScript modules** `admin/src/i18n/en.ts` and `admin/src/i18n/pt.ts`, keyed under `padmakara.*`; components use `const translate = useTranslate();` then `translate("padmakara.aiAssist.<key>")`. No hardcoded user-facing English.
- The admin UI has **no test tooling**; do not add a frontend unit-test harness. Frontend correctness is verified by `bun run typecheck` + a browser pass (see final task).
- Event text fields on the form are `titleEn`, `titlePt`, `mainThemesEn`, `mainThemesPt`, `sessionThemesEn`, `sessionThemesPt`; date fields `startDate`, `endDate` (strings, `YYYY-MM-DD` or `""`). There is **no** single `description` field. Excluded from AI: teachers, groups, places, `status`, `featuredAt`, `eventCode`.
- The AI never writes to S3 or the DB; the host applies suggestions after the user confirms.

## File Structure

- `src/services/ai-assist.ts` — **new.** Shared AI call: prompt assembly, Anthropic call, fence-strip, parse, speaker resolution, date validation. Pure-ish (takes roster + apiKey as args).
- `src/lib/schemas.ts` — **modify.** Add `aiAssistSchema` (supersedes `renameTracksSchema`, which is kept until Task 2).
- `src/routes/admin/upload.ts` — **modify.** `POST /rename-tracks` becomes a thin wrapper over the service.
- `src/routes/admin/events.ts` — **modify.** `POST /:id/rename-tracks` becomes a thin wrapper over the service.
- `tests/services/ai-assist.test.ts` — **new.** Unit tests for the service (expanded contract).
- `tests/routes/admin/rename-tracks.test.ts` — **modify** (Task 2) to the new response contract.
- `tests/routes/admin/upload.test.ts` — **modify** if it asserts the old rename-tracks shape.
- `admin/src/components/AiAssistPanel.tsx` — **new.** The shared textarea + review UI.
- `admin/src/i18n/en.ts`, `admin/src/i18n/pt.ts` — **modify.** Add `padmakara.aiAssist.*` keys.
- `admin/src/resources/events.tsx` — **modify.** Render `AiAssistPanel` in `EventCreate` and `EventEdit`; add `handleAiApply` to each; drop `enableAiRename`.
- `admin/src/components/SessionTrackTable.tsx` — **modify.** Remove the embedded AI box + `enableAiRename` prop + `handleApplyAi` + `AiSuggestion` type.

---

## Task 1: Extract the backend AI logic into a shared service (behavior-preserving)

Pure refactor. The two `rename-tracks` handlers are byte-for-byte identical except the route path. Move the shared body into `src/services/ai-assist.ts` keeping the **current** `{ suggestions }` contract, so the existing `rename-tracks.test.ts` and `upload.test.ts` stay green.

**Files:**
- Create: `src/services/ai-assist.ts`
- Modify: `src/routes/admin/upload.ts` (handler at 146–226)
- Modify: `src/routes/admin/events.ts` (handler at 294–376)
- Test: existing `tests/routes/admin/rename-tracks.test.ts`, `tests/routes/admin/upload.test.ts` (unchanged; must stay green)

**Interfaces:**
- Consumes: `renameTracksSchema` (`src/lib/schemas.ts`), `resolveSpeaker`, `rosterPromptBlock`, `RosterTeacher` (`src/services/speaker-resolve.ts`), `AppError` (`src/lib/errors.ts`).
- Produces:
  ```ts
  // src/services/ai-assist.ts
  export interface RenameTrackRow { rowKey: string; originalFilename: string; title: string; speaker?: string | null; }
  export interface RenameSuggestion { rowKey: string; title?: string; speaker?: string; speakerUnmatched?: true; }
  export async function renameTracks(args: {
    instruction: string;
    rows: RenameTrackRow[];
    roster: RosterTeacher[];
    apiKey: string;
  }): Promise<{ suggestions: RenameSuggestion[] }>;
  ```

- [ ] **Step 1: Run the existing tests to establish the green baseline**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/admin/rename-tracks.test.ts tests/routes/admin/upload.test.ts'`
Expected: PASS (all).

- [ ] **Step 2: Create the shared service**

Create `src/services/ai-assist.ts` by lifting the exact logic from `upload.ts` 159–225:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../lib/errors.ts";
import {
  resolveSpeaker,
  rosterPromptBlock,
  type RosterTeacher,
} from "./speaker-resolve.ts";

export interface RenameTrackRow {
  rowKey: string;
  originalFilename: string;
  title: string;
  speaker?: string | null;
}

export interface RenameSuggestion {
  rowKey: string;
  title?: string;
  speaker?: string;
  speakerUnmatched?: true;
}

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  'You are helping a Buddhist retreat administrator clean up audio track ' +
  "titles for a content management system. You will receive a list of track " +
  "rows and a plain-English instruction. Apply the instruction to the rows " +
  'and return suggested edits as a JSON array. Each element has "rowKey" ' +
  '(unchanged) and optionally "title" and/or "speaker" with the suggested ' +
  "new values. Only include fields that should change. Return only the JSON " +
  "array, no markdown fences, no prose.";

/** Strip a leading/trailing markdown code fence, if present. */
function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  return t;
}

export async function renameTracks(args: {
  instruction: string;
  rows: RenameTrackRow[];
  roster: RosterTeacher[];
  apiKey: string;
}): Promise<{ suggestions: RenameSuggestion[] }> {
  const { instruction, rows, roster, apiKey } = args;
  const anthropic = new Anthropic({ apiKey });
  const rowsJson = JSON.stringify(rows, null, 2);

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${SYSTEM_PROMPT}${rosterPromptBlock(roster)}`,
    messages: [
      { role: "user", content: `Instruction: ${instruction}\n\nRows:\n${rowsJson}` },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  let suggestions: RenameSuggestion[];
  try {
    const raw: unknown = JSON.parse(stripFences(textBlock.text));
    if (!Array.isArray(raw)) throw new Error("Expected array");
    suggestions = raw.map((item: unknown) => {
      if (typeof item !== "object" || item === null) throw new Error("Bad item");
      const s = item as Record<string, unknown>;
      const out: RenameSuggestion = { rowKey: String(s.rowKey ?? "") };
      if (typeof s.title === "string") out.title = s.title;
      if (typeof s.speaker === "string") {
        const resolved = resolveSpeaker(s.speaker, roster);
        out.speaker = resolved.speaker;
        if (resolved.unmatched) out.speakerUnmatched = true;
      }
      return out;
    });
  } catch {
    throw AppError.internal("Failed to parse AI rename response");
  }

  return { suggestions };
}
```

- [ ] **Step 3: Make `upload.ts` delegate to the service**

In `src/routes/admin/upload.ts`, replace the body of `uploadRoutes.post("/rename-tracks", ...)` (currently 146–226) so it validates, loads roster + apiKey, and calls the service. Keep the imports for `renameTracksSchema`, `db`, `AppError`. Remove the now-unused `Anthropic`, `resolveSpeaker`, `rosterPromptBlock` imports **from this file only if nothing else uses them** (check first). New handler:

```ts
uploadRoutes.post("/rename-tracks", async (c) => {
  const parsed = renameTracksSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const roster = await db.query.teachers.findMany({
    columns: { abbreviation: true, name: true },
  });
  const result = await renameTracks({ ...parsed.data, roster, apiKey });
  return c.json(result);
});
```

Add at the top: `import { renameTracks } from "../../services/ai-assist.ts";`

- [ ] **Step 4: Make `events.ts` delegate to the service**

In `src/routes/admin/events.ts`, replace the body of `eventRoutes.post("/:id/rename-tracks", ...)` (294–376) with the same delegation:

```ts
eventRoutes.post("/:id/rename-tracks", async (c) => {
  const parsed = renameTracksSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const roster = await db.query.teachers.findMany({
    columns: { abbreviation: true, name: true },
  });
  const result = await renameTracks({ ...parsed.data, roster, apiKey });
  return c.json(result);
});
```

Add `import { renameTracks } from "../../services/ai-assist.ts";`. Remove now-unused `Anthropic`/`resolveSpeaker`/`rosterPromptBlock` imports **only if** no other handler in `events.ts` uses them (grep first; if used elsewhere, leave them).

- [ ] **Step 5: Run typecheck + the existing tests — must still be green**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun run typecheck'`
Expected: no errors.
Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/admin/rename-tracks.test.ts tests/routes/admin/upload.test.ts'`
Expected: PASS (all) — behavior unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai-assist.ts src/routes/admin/upload.ts src/routes/admin/events.ts
git commit -m "refactor(admin): extract rename-tracks AI logic into shared service

The two rename-tracks handlers were byte-for-byte identical. Move the
Anthropic call, fence-strip, parse and speaker resolution into
src/services/ai-assist.ts; both routes now delegate. No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Expand the service + schema to event/session/track suggestions

Grow the contract from a flat track array to `{ event?, sessions, tracks }`, expand the prompt with the explicit-intent + date rules, validate dates, and update the routes and existing route tests.

**Files:**
- Modify: `src/services/ai-assist.ts`
- Modify: `src/lib/schemas.ts` (add `aiAssistSchema`)
- Modify: `src/routes/admin/upload.ts`, `src/routes/admin/events.ts` (use `aiAssistSchema` + `aiAssistEvent`)
- Create: `tests/services/ai-assist.test.ts`
- Modify: `tests/routes/admin/rename-tracks.test.ts` (new response shape)
- Modify: `tests/routes/admin/upload.test.ts` (if it asserts rename-tracks shape)

**Interfaces:**
- Produces:
  ```ts
  export interface AiEventFields {
    titleEn?: string; titlePt?: string;
    mainThemesEn?: string; mainThemesPt?: string;
    sessionThemesEn?: string; sessionThemesPt?: string;
    startDate?: string; endDate?: string;
  }
  export interface AiSessionRow { rowKey: string; titleEn?: string; titlePt?: string; }
  export interface AiSessionSuggestion { rowKey: string; titleEn?: string; titlePt?: string; }
  export async function aiAssistEvent(args: {
    instruction: string;
    event?: AiEventFields;
    sessions?: AiSessionRow[];
    tracks: RenameTrackRow[];         // reused from Task 1
    roster: RosterTeacher[];
    apiKey: string;
  }): Promise<{
    event?: AiEventFields;
    sessions: AiSessionSuggestion[];
    tracks: RenameSuggestion[];       // reused from Task 1
  }>;
  ```

- [ ] **Step 1: Add the schema**

In `src/lib/schemas.ts`, directly after `renameTracksSchema` (330), add:

```ts
// AI assist (event + sessions + tracks)
const aiEventFieldsSchema = z.object({
  titleEn: z.string().max(500).optional(),
  titlePt: z.string().max(500).optional(),
  mainThemesEn: z.string().max(5000).optional(),
  mainThemesPt: z.string().max(5000).optional(),
  sessionThemesEn: z.string().max(5000).optional(),
  sessionThemesPt: z.string().max(5000).optional(),
  startDate: z.string().max(20).optional(),
  endDate: z.string().max(20).optional(),
});

export const aiAssistSchema = z.object({
  instruction: z.string().min(1).max(2000),
  event: aiEventFieldsSchema.optional(),
  sessions: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(100),
        titleEn: z.string().max(500).optional(),
        titlePt: z.string().max(500).optional(),
      }),
    )
    .max(200)
    .optional(),
  tracks: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(100),
        originalFilename: z.string().min(1).max(500),
        title: z.string().min(1).max(500),
        speaker: z.string().max(100).optional().nullable(),
      }),
    )
    .min(1)
    .max(200),
});
```

- [ ] **Step 2: Write the failing service test**

Create `tests/services/ai-assist.test.ts`. Mock only the Anthropic SDK (the service takes roster/apiKey as args, so no db mock needed):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { aiAssistEvent } from "../../src/services/ai-assist.ts";

const ROSTER = [
  { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" },
  { abbreviation: "PWR", name: "Pema Wangyal Rinpoche" },
];
const TRACKS = [
  { rowKey: "t1", originalFilename: "001.mp3", title: "opening", speaker: null },
];

function aiReply(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

describe("aiAssistEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only track suggestions for a track-only instruction", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ tracks: [{ rowKey: "t1", title: "Opening" }] }),
    );
    const out = await aiAssistEvent({
      instruction: "Title case", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", title: "Opening" }]);
    expect(out.sessions).toEqual([]);
    expect(out.event).toBeUndefined();
  });

  it("returns event field suggestions when the instruction asks about the event", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ event: { titleEn: "Spring Retreat 2025" }, tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Rename the event title to Spring Retreat 2025",
      event: { titleEn: "spring retreat" }, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.event).toEqual({ titleEn: "Spring Retreat 2025" });
  });

  it("returns session title suggestions", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ sessions: [{ rowKey: "s0", titleEn: "Morning Session" }], tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Title-case the session titles",
      sessions: [{ rowKey: "s0", titleEn: "morning session" }],
      tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.sessions).toEqual([{ rowKey: "s0", titleEn: "Morning Session" }]);
  });

  it("drops a malformed date but keeps a valid one", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ event: { startDate: "2025-04-12", endDate: "next tuesday" }, tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Set start date to 12 April 2025",
      event: {}, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.event).toEqual({ startDate: "2025-04-12" });
  });

  it("resolves a track speaker to its abbreviation and flags unmatched", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ tracks: [
        { rowKey: "t1", speaker: "Jigme Khyentse Rinpoche" },
      ] }),
    );
    const out = await aiAssistEvent({
      instruction: "Set speaker to Jigme", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks[0]).toMatchObject({ rowKey: "t1", speaker: "JKR" });
    expect(out.tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("strips markdown fences around the JSON object", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "```json\n" + JSON.stringify({ tracks: [{ rowKey: "t1", title: "X" }] }) + "\n```" }],
    });
    const out = await aiAssistEvent({
      instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", title: "X" }]);
  });

  it("throws when the AI response is not valid JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "nope" }] });
    await expect(
      aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/ai-assist.test.ts'`
Expected: FAIL (`aiAssistEvent` is not exported yet).

- [ ] **Step 4: Implement `aiAssistEvent` in the service**

Add to `src/services/ai-assist.ts` (keep `renameTracks` for now; it will be removed once routes migrate). Add the types from the Interfaces block, the date regex, and:

```ts
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ASSIST_SYSTEM_PROMPT =
  "You are helping a Buddhist retreat administrator edit a retreat event in a " +
  "content management system. You receive the event's current fields, its " +
  "sessions, its tracks, and a plain-English instruction. Return ONLY a JSON " +
  'object with optional keys "event", "sessions", and "tracks":\n' +
  '- "event": an object with any of titleEn, titlePt, mainThemesEn, mainThemesPt, ' +
  "sessionThemesEn, sessionThemesPt, startDate, endDate — only the fields that " +
  "should change. Dates must be ISO YYYY-MM-DD.\n" +
  '- "sessions": an array of { rowKey, titleEn?, titlePt? } for sessions that ' +
  "should change (rowKey unchanged).\n" +
  '- "tracks": an array of { rowKey, title?, speaker? } for tracks that should ' +
  "change (rowKey unchanged).\n" +
  "IMPORTANT: only suggest changes to event or session fields when the " +
  "instruction explicitly asks about the event or the sessions. If the " +
  "instruction is only about track titles or speakers, return just the " +
  '"tracks" array and leave event/sessions empty. Include only fields that ' +
  "change. Return only the JSON object, no markdown fences, no prose.";

function cleanEvent(raw: unknown): AiEventFields | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  const out: AiEventFields = {};
  for (const k of ["titleEn", "titlePt", "mainThemesEn", "mainThemesPt", "sessionThemesEn", "sessionThemesPt"] as const) {
    if (typeof s[k] === "string") out[k] = s[k] as string;
  }
  for (const k of ["startDate", "endDate"] as const) {
    if (typeof s[k] === "string" && ISO_DATE.test(s[k] as string)) out[k] = s[k] as string;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function aiAssistEvent(args: {
  instruction: string;
  event?: AiEventFields;
  sessions?: AiSessionRow[];
  tracks: RenameTrackRow[];
  roster: RosterTeacher[];
  apiKey: string;
}): Promise<{ event?: AiEventFields; sessions: AiSessionSuggestion[]; tracks: RenameSuggestion[] }> {
  const { instruction, event, sessions = [], tracks, roster, apiKey } = args;
  const anthropic = new Anthropic({ apiKey });

  const payload = JSON.stringify({ event: event ?? {}, sessions, tracks }, null, 2);
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${ASSIST_SYSTEM_PROMPT}${rosterPromptBlock(roster)}`,
    messages: [
      { role: "user", content: `Instruction: ${instruction}\n\nCurrent data:\n${payload}` },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  try {
    const raw: unknown = JSON.parse(stripFences(textBlock.text));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Expected object");
    }
    const r = raw as Record<string, unknown>;

    const outEvent = cleanEvent(r.event);

    const outSessions: AiSessionSuggestion[] = Array.isArray(r.sessions)
      ? r.sessions.flatMap((item): AiSessionSuggestion[] => {
          if (typeof item !== "object" || item === null) return [];
          const s = item as Record<string, unknown>;
          const sug: AiSessionSuggestion = { rowKey: String(s.rowKey ?? "") };
          if (typeof s.titleEn === "string") sug.titleEn = s.titleEn;
          if (typeof s.titlePt === "string") sug.titlePt = s.titlePt;
          return sug.rowKey ? [sug] : [];
        })
      : [];

    const outTracks: RenameSuggestion[] = Array.isArray(r.tracks)
      ? r.tracks.flatMap((item): RenameSuggestion[] => {
          if (typeof item !== "object" || item === null) return [];
          const s = item as Record<string, unknown>;
          const sug: RenameSuggestion = { rowKey: String(s.rowKey ?? "") };
          if (typeof s.title === "string") sug.title = s.title;
          if (typeof s.speaker === "string") {
            const resolved = resolveSpeaker(s.speaker, roster);
            sug.speaker = resolved.speaker;
            if (resolved.unmatched) sug.speakerUnmatched = true;
          }
          return sug.rowKey ? [sug] : [];
        })
      : [];

    return { event: outEvent, sessions: outSessions, tracks: outTracks };
  } catch {
    throw AppError.internal("Failed to parse AI assist response");
  }
}
```

- [ ] **Step 5: Run the service test — expect pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/ai-assist.test.ts'`
Expected: PASS.

- [ ] **Step 6: Point both routes at `aiAssistEvent` + `aiAssistSchema`**

In `src/routes/admin/upload.ts` and `src/routes/admin/events.ts`, change the handler to parse with `aiAssistSchema` and call `aiAssistEvent`:

```ts
// imports: replace renameTracks with aiAssistEvent; replace renameTracksSchema with aiAssistSchema
const parsed = aiAssistSchema.safeParse(await c.req.json().catch(() => null));
if (!parsed.success) throw AppError.badRequest("Invalid request body", "VALIDATION_ERROR");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");
const roster = await db.query.teachers.findMany({ columns: { abbreviation: true, name: true } });
const result = await aiAssistEvent({ ...parsed.data, roster, apiKey });
return c.json(result);
```

Then delete the now-unused `renameTracks` export and `renameTracksSchema` (schemas.ts) if nothing else references them (grep both names first; the old schema may still be referenced by a test until Step 7).

- [ ] **Step 7: Update the route tests to the new contract**

Rewrite `tests/routes/admin/rename-tracks.test.ts` request bodies to `{ instruction, tracks }` (rename `rows` → `tracks`) and response assertions from `body.suggestions` to `body.tracks`. Replace the two "not an array" / array-shaped cases with object-shaped equivalents. Add a case asserting an event instruction returns `body.event`, and a session instruction returns `body.sessions`. Update `tests/routes/admin/upload.test.ts` similarly if it exercises `/rename-tracks` (grep it for `rename-tracks` / `suggestions`; leave unrelated upload cases alone). Keep the auth (401/403), validation (400), missing-key (500), and speaker-resolution cases — adjust their bodies/asserts to the new shape.

- [ ] **Step 8: Run the full admin + service test group + typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun run typecheck'`
Expected: no errors.
Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/services/ai-assist.test.ts tests/routes/admin/rename-tracks.test.ts tests/routes/admin/upload.test.ts'`
Expected: PASS (all).

- [ ] **Step 9: Commit**

```bash
git add src/services/ai-assist.ts src/lib/schemas.ts src/routes/admin/upload.ts src/routes/admin/events.ts tests/services/ai-assist.test.ts tests/routes/admin/rename-tracks.test.ts tests/routes/admin/upload.test.ts
git commit -m "feat(admin): expand AI assist to event fields and session titles

The rename-tracks endpoints now accept { instruction, event?, sessions?,
tracks } and return { event?, sessions, tracks }. Event/session edits are
gated behind explicit instruction intent in the prompt; dates are validated
to ISO and dropped otherwise.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Build the shared `AiAssistPanel` component + locale keys

A standalone MUI card: instruction textarea → "Ask AI" (fetch) → review diff (old→new, grouped Event/Sessions/Tracks) → "Apply changes" / "Discard".

**Files:**
- Create: `admin/src/components/AiAssistPanel.tsx`
- Modify: `admin/src/i18n/en.ts`, `admin/src/i18n/pt.ts`

**Interfaces:**
- Consumes: `authFetch` (`../utils/authFetch`), `useNotify` + `useTranslate` (`react-admin`), MUI.
- Produces:
  ```ts
  export interface AiAssistEventFields {
    titleEn?: string; titlePt?: string;
    mainThemesEn?: string; mainThemesPt?: string;
    sessionThemesEn?: string; sessionThemesPt?: string;
    startDate?: string; endDate?: string;
  }
  export interface AiAssistTrack { rowKey: string; originalFilename: string; title: string; speaker?: string | null; }
  export interface AiAssistSession { rowKey: string; titleEn?: string; titlePt?: string; }
  export interface AiAssistResult {
    event?: AiAssistEventFields;
    sessions: Array<{ rowKey: string; titleEn?: string; titlePt?: string }>;
    tracks: Array<{ rowKey: string; title?: string; speaker?: string; speakerUnmatched?: true }>;
  }
  interface AiAssistPanelProps {
    event: AiAssistEventFields;
    sessions: AiAssistSession[];
    tracks: AiAssistTrack[];
    endpoint: string;
    onApply: (result: AiAssistResult) => void | Promise<void>;
  }
  export function AiAssistPanel(props: AiAssistPanelProps): JSX.Element;
  ```

- [ ] **Step 1: Add locale keys**

In `admin/src/i18n/en.ts`, inside the `padmakara` object, add a sibling section to `events`:

```ts
    aiAssist: {
      heading: "AI assistant",
      caption: "Describe a change to apply to this event, its sessions and tracks",
      placeholder:
        'e.g. "Title-case every track title", "Remove the speaker initials", ' +
        'or "Set the speaker to JKR on the second session"',
      ask: "Ask AI",
      thinking: "Thinking…",
      reviewTitle: "Proposed changes",
      noChanges: "The AI proposed no changes.",
      apply: "Apply changes",
      discard: "Discard",
      sectionEvent: "Event",
      sectionSessions: "Sessions",
      sectionTracks: "Tracks",
      unmatchedSpeaker: "unmatched — review",
      applied: "AI changes applied — remember to save",
      failed: "AI request failed",
    },
```

In `admin/src/i18n/pt.ts`, add the same keys translated:

```ts
    aiAssist: {
      heading: "Assistente AI",
      caption: "Descreva uma alteração a aplicar a este evento, às suas sessões e faixas",
      placeholder:
        'ex.: "Capitalizar todos os títulos das faixas", "Remover as iniciais do orador", ' +
        'ou "Definir o orador como JKR na segunda sessão"',
      ask: "Perguntar à AI",
      thinking: "A pensar…",
      reviewTitle: "Alterações propostas",
      noChanges: "A AI não propôs alterações.",
      apply: "Aplicar alterações",
      discard: "Descartar",
      sectionEvent: "Evento",
      sectionSessions: "Sessões",
      sectionTracks: "Faixas",
      unmatchedSpeaker: "sem correspondência — reveja",
      applied: "Alterações da AI aplicadas — não se esqueça de guardar",
      failed: "Pedido à AI falhou",
    },
```

- [ ] **Step 2: Write the component**

Create `admin/src/components/AiAssistPanel.tsx`:

```tsx
import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";

export interface AiAssistEventFields {
  titleEn?: string; titlePt?: string;
  mainThemesEn?: string; mainThemesPt?: string;
  sessionThemesEn?: string; sessionThemesPt?: string;
  startDate?: string; endDate?: string;
}
export interface AiAssistTrack {
  rowKey: string; originalFilename: string; title: string; speaker?: string | null;
}
export interface AiAssistSession { rowKey: string; titleEn?: string; titlePt?: string; }
export interface AiAssistResult {
  event?: AiAssistEventFields;
  sessions: Array<{ rowKey: string; titleEn?: string; titlePt?: string }>;
  tracks: Array<{ rowKey: string; title?: string; speaker?: string; speakerUnmatched?: true }>;
}
interface AiAssistPanelProps {
  event: AiAssistEventFields;
  sessions: AiAssistSession[];
  tracks: AiAssistTrack[];
  endpoint: string;
  onApply: (result: AiAssistResult) => void | Promise<void>;
}

interface DiffRow { label: string; from: string; to: string; unmatched?: boolean; }

export function AiAssistPanel({ event, sessions, tracks, endpoint, onApply }: AiAssistPanelProps) {
  const translate = useTranslate();
  const notify = useNotify();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiAssistResult | null>(null);

  const t = (k: string) => translate(`padmakara.aiAssist.${k}`);

  const trackByKey = useMemo(
    () => new Map(tracks.map((tr) => [tr.rowKey, tr])),
    [tracks],
  );
  const sessionByKey = useMemo(
    () => new Map(sessions.map((s) => [s.rowKey, s])),
    [sessions],
  );

  const eventDiffs = useMemo<DiffRow[]>(() => {
    if (!result?.event) return [];
    return (Object.keys(result.event) as (keyof AiAssistEventFields)[]).map((k) => ({
      label: k,
      from: event[k] ?? "",
      to: result.event![k] ?? "",
    }));
  }, [result, event]);

  const sessionDiffs = useMemo<DiffRow[]>(() => {
    if (!result) return [];
    return result.sessions.flatMap((s) => {
      const cur = sessionByKey.get(s.rowKey);
      const rows: DiffRow[] = [];
      if (s.titleEn !== undefined) rows.push({ label: `EN`, from: cur?.titleEn ?? "", to: s.titleEn });
      if (s.titlePt !== undefined) rows.push({ label: `PT`, from: cur?.titlePt ?? "", to: s.titlePt });
      return rows;
    });
  }, [result, sessionByKey]);

  const trackDiffs = useMemo<DiffRow[]>(() => {
    if (!result) return [];
    return result.tracks.flatMap((tr) => {
      const cur = trackByKey.get(tr.rowKey);
      const rows: DiffRow[] = [];
      if (tr.title !== undefined) rows.push({ label: cur?.title ?? tr.rowKey, from: cur?.title ?? "", to: tr.title });
      if (tr.speaker !== undefined) rows.push({ label: "speaker", from: cur?.speaker ?? "", to: tr.speaker, unmatched: tr.speakerUnmatched });
      return rows;
    });
  }, [result, trackByKey]);

  const totalChanges = eventDiffs.length + sessionDiffs.length + trackDiffs.length;

  const handleAsk = async () => {
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await authFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text, event, sessions, tracks }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = (await res.json()) as AiAssistResult;
      setResult({ event: data.event, sessions: data.sessions ?? [], tracks: data.tracks ?? [] });
    } catch (e) {
      notify(`${t("failed")}: ${(e as Error).message}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!result) return;
    await onApply(result);
    setResult(null);
    setInstruction("");
    notify(t("applied"), { type: "info" });
  };

  const renderDiffs = (title: string, rows: DiffRow[]) =>
    rows.length > 0 && (
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 700, textTransform: "uppercase", opacity: 0.7 }}>
          {title}
        </Typography>
        {rows.map((r, i) => (
          <Box key={i} sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", py: 0.25 }}>
            <Typography variant="body2" sx={{ minWidth: 120, opacity: 0.8 }}>{r.label}</Typography>
            <Typography variant="body2" sx={{ textDecoration: "line-through", opacity: 0.6 }}>{r.from || "—"}</Typography>
            <Typography variant="body2">→</Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.to || "—"}</Typography>
            {r.unmatched && <Chip size="small" color="warning" label={t("unmatchedSpeaker")} />}
          </Box>
        ))}
      </Box>
    );

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2, mb: 2,
        borderColor: "rgba(91,94,166,0.35)",
        background: "linear-gradient(135deg, rgba(91,94,166,0.07), rgba(91,94,166,0.02))",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
        <AutoAwesomeIcon sx={{ color: "primary.main", fontSize: 20 }} />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t("heading")}</Typography>
        <Typography variant="caption" color="text.secondary">{t("caption")}</Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
        <TextField
          fullWidth size="small" multiline minRows={3} maxRows={6}
          placeholder={t("placeholder")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
          sx={{ backgroundColor: "background.paper", borderRadius: 1 }}
        />
        <Button
          variant="contained" startIcon={<AutoAwesomeIcon />}
          onClick={() => void handleAsk()}
          disabled={busy || instruction.trim() === ""}
          sx={{ flexShrink: 0, minWidth: 120, textTransform: "none", borderRadius: 2 }}
        >
          {busy ? t("thinking") : t("ask")}
        </Button>
      </Box>

      {result && (
        <Box sx={{ mt: 2 }}>
          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>{t("reviewTitle")}</Typography>
          {totalChanges === 0 ? (
            <Typography variant="body2" color="text.secondary">{t("noChanges")}</Typography>
          ) : (
            <>
              {renderDiffs(t("sectionEvent"), eventDiffs)}
              {renderDiffs(t("sectionSessions"), sessionDiffs)}
              {renderDiffs(t("sectionTracks"), trackDiffs)}
              <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                <Button variant="contained" size="small" onClick={() => void handleApply()} sx={{ textTransform: "none" }}>
                  {t("apply")}
                </Button>
                <Button variant="text" size="small" onClick={() => setResult(null)} sx={{ textTransform: "none" }}>
                  {t("discard")}
                </Button>
              </Box>
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}
```

- [ ] **Step 3: Typecheck the admin build**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && /usr/bin/env npx tsc --noEmit'`
Expected: no errors in `AiAssistPanel.tsx` / `i18n`. (If the admin has no `tsc` script, use `npx tsc -p tsconfig.json --noEmit`.)

- [ ] **Step 4: Commit**

```bash
git add admin/src/components/AiAssistPanel.tsx admin/src/i18n/en.ts admin/src/i18n/pt.ts
git commit -m "feat(admin): add shared AiAssistPanel component with review gate

Localized textarea + old->new diff review for event/session/track AI
suggestions. Non-destructive: hands a reviewed result to the host via
onApply.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `AiAssistPanel` into `EventCreate`

Replace `SessionTrackTable`'s `enableAiRename` box with `AiAssistPanel` rendered by `EventCreate`, operating on `form` + `sessions` (the InferredSession source of truth).

**Files:**
- Modify: `admin/src/resources/events.tsx` (`EventCreate`, ~1567–1990)

**Interfaces:**
- Consumes: `AiAssistPanel`, `AiAssistResult` (`../components/AiAssistPanel`), `detectTitleLanguage` (`../utils/trackParser`, already imported in events.tsx? if not, import it), `fileKey`.

- [ ] **Step 1: Import the panel + helpers**

At the top of `admin/src/resources/events.tsx`, add:
```ts
import { AiAssistPanel, type AiAssistResult } from "../components/AiAssistPanel";
```
Confirm `detectTitleLanguage` is imported (it is used by SessionTrackTable, not necessarily here) — if absent, add `import { detectTitleLanguage } from "../utils/trackParser";`.

- [ ] **Step 2: Add a shared apply helper for create-mode sessions**

Inside `EventCreate` (near `handleSave`), add a memoized handler that maps an `AiAssistResult` onto `form` + `sessions`, preserving each track's `.file` so `fileKey` stays stable:

```ts
const handleAiApply = useCallback((result: AiAssistResult) => {
  if (result.event) {
    setForm((f) => ({
      ...f,
      ...result.event,
      titleEnReviewed: result.event!.titleEn !== undefined ? true : f.titleEnReviewed,
      titlePtReviewed: result.event!.titlePt !== undefined ? true : f.titlePtReviewed,
    }));
  }
  const sessById = new Map(result.sessions.map((s) => [s.rowKey, s]));
  const trackById = new Map(result.tracks.map((t) => [t.rowKey, t]));
  setSessions((prev) =>
    prev.map((s, i) => {
      const sSug = sessById.get(`s${i}`);
      const nextTitleEn = sSug?.titleEn ?? s.titleEn;
      const nextTitlePt = sSug?.titlePt ?? s.titlePt;
      return {
        ...s,
        titleEn: nextTitleEn,
        titlePt: nextTitlePt,
        titleEnReviewed: sSug?.titleEn !== undefined ? true : s.titleEnReviewed,
        titlePtReviewed: sSug?.titlePt !== undefined ? true : s.titlePtReviewed,
        tracks: s.tracks.map((tk) => {
          const tSug = trackById.get(fileKey(tk.file));
          if (!tSug) return tk;
          let next = { ...tk };
          if (tSug.title != null) {
            const lang = detectTitleLanguage(tSug.title);
            next = lang === "pt"
              ? { ...next, titlePt: tSug.title, titlePtReviewed: true }
              : { ...next, titleEn: tSug.title, titleEnReviewed: true };
          }
          if (tSug.speaker != null) next = { ...next, speaker: tSug.speaker };
          return next;
        }),
      };
    }),
  );
}, []);
```

(If `InferredSession`/`ParsedTrack` fields differ from `titleEnReviewed`/`file`, match the actual field names in `events.tsx` — verify against the type definitions before writing.)

- [ ] **Step 3: Build the panel props + render it, drop `enableAiRename`**

Replace the `<SessionTrackTable ... enableAiRename ... />` block (1976–1984) — remove `enableAiRename` — and render `AiAssistPanel` immediately above it:

```tsx
<AiAssistPanel
  endpoint="/api/admin/upload/rename-tracks"
  event={{
    titleEn: form.titleEn, titlePt: form.titlePt,
    mainThemesEn: form.mainThemesEn, mainThemesPt: form.mainThemesPt,
    sessionThemesEn: form.sessionThemesEn, sessionThemesPt: form.sessionThemesPt,
    startDate: form.startDate, endDate: form.endDate,
  }}
  sessions={sessions.map((s, i) => ({ rowKey: `s${i}`, titleEn: s.titleEn, titlePt: s.titlePt }))}
  tracks={sessions.flatMap((s) => s.tracks).map((tk) => ({
    rowKey: fileKey(tk.file),
    originalFilename: tk.originalFilename,
    title: tk.titleEn || tk.titlePt || tk.title,
    speaker: tk.speaker ?? "",
  }))}
  onApply={handleAiApply}
/>
<SessionTrackTable
  value={sessionsToTableValue(sessions)}
  onChange={(tv) => setSessions(tableValueToSessions(tv, sessions))}
  teachers={allTeachers}
  enablePractice
  editableFilename
  trackCorrections={trackCorrections}
/>
```

Render the panel only when there are tracks: wrap in `{sessions.some((s) => s.tracks.length > 0) && ( ... )}`.

- [ ] **Step 4: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && /usr/bin/env npx tsc -p tsconfig.json --noEmit'`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add admin/src/resources/events.tsx
git commit -m "feat(admin): render AiAssistPanel on the event create form

Replaces SessionTrackTable's embedded enableAiRename box with the shared
panel operating on the event form + parsed sessions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire `AiAssistPanel` into `EventEdit`

Render the panel in `EventEdit`, applying event fields to `form` (staged for Save) and session/track suggestions through the existing immediate-persist handlers.

**Files:**
- Modify: `admin/src/resources/events.tsx` (`EventEdit`, ~2076–2760)

**Interfaces:**
- Consumes: `AiAssistPanel`, `AiAssistResult`, `handleTrackUpdate` (2191), `handleSessionTitleChange` (2166), `detectTitleLanguage`, `refresh`, `sessions`, `form`, `id`.

- [ ] **Step 1: Add the edit-mode apply handler**

Inside `EventEdit` (after `handleSessionTitleChange` / `handleTrackUpdate`), add:

```ts
const handleAiApply = useCallback(async (result: AiAssistResult) => {
  // Event fields → staged into form; persisted when the admin clicks Save.
  if (result.event) {
    setForm((f) => ({
      ...f,
      ...result.event,
      titleEnReviewed: result.event!.titleEn !== undefined ? true : f.titleEnReviewed,
      titlePtReviewed: result.event!.titlePt !== undefined ? true : f.titlePtReviewed,
    }));
  }
  // Session titles → immediate persist via the existing handler.
  for (const s of result.sessions) {
    const idx = sessions.findIndex((x) => String(x.id) === s.rowKey);
    if (idx < 0) continue;
    const patch: Record<string, unknown> = {};
    if (s.titleEn !== undefined) { patch.titleEn = s.titleEn; patch.titleEnReviewed = true; }
    if (s.titlePt !== undefined) { patch.titlePt = s.titlePt; patch.titlePtReviewed = true; }
    if (Object.keys(patch).length) await handleSessionTitleChange(idx, patch, { silent: true });
  }
  // Tracks → immediate persist via the existing handler.
  for (const tr of result.tracks) {
    const trackId = Number(tr.rowKey);
    if (!Number.isFinite(trackId)) continue;
    const updates: Record<string, unknown> = {};
    if (tr.title != null) {
      const lang = detectTitleLanguage(tr.title);
      if (lang === "pt") { updates.titlePt = tr.title; updates.titlePtReviewed = true; }
      else { updates.titleEn = tr.title; updates.titleEnReviewed = true; }
    }
    if (tr.speaker != null) updates.speaker = tr.speaker;
    if (Object.keys(updates).length) await handleTrackUpdate(trackId, updates, { silent: true });
  }
  refresh();
}, [sessions, handleSessionTitleChange, handleTrackUpdate, refresh]);
```

(Confirm `handleSessionTitleChange`'s signature accepts `{ silent }` — it does, 2166–2189 — and that `InferredSession` has `id`.)

- [ ] **Step 2: Render the panel after `EventFormFields`**

Directly after the `<EventFormFields ... />` block (closes ~2681), add (gated on track count):

```tsx
{trackCount > 0 && (
  <AiAssistPanel
    endpoint={`/api/admin/events/${id}/rename-tracks`}
    event={{
      titleEn: form.titleEn, titlePt: form.titlePt,
      mainThemesEn: form.mainThemesEn, mainThemesPt: form.mainThemesPt,
      sessionThemesEn: form.sessionThemesEn, sessionThemesPt: form.sessionThemesPt,
      startDate: form.startDate, endDate: form.endDate,
    }}
    sessions={sessions.map((s) => ({ rowKey: String(s.id), titleEn: s.titleEn, titlePt: s.titlePt }))}
    tracks={sessions.flatMap((s) => s.tracks).map((tk) => ({
      rowKey: String(tk.id),
      originalFilename: tk.originalFilename ?? "",
      title: tk.titleEn || tk.titlePt || tk.title,
      speaker: tk.speaker ?? "",
    }))}
    onApply={handleAiApply}
  />
)}
```

- [ ] **Step 3: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && /usr/bin/env npx tsc -p tsconfig.json --noEmit'`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add admin/src/resources/events.tsx
git commit -m "feat(admin): render AiAssistPanel on the event edit form

Event field suggestions stage into the form (saved via Save); session and
track suggestions persist immediately through the existing update handlers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Remove the dead AI box from `SessionTrackTable`

Now that `AiAssistPanel` owns the AI UI, delete the embedded box so there is one implementation.

**Files:**
- Modify: `admin/src/components/SessionTrackTable.tsx`

- [ ] **Step 1: Delete the AI code**

Remove: the `enableAiRename` prop from `SessionTrackTableProps` (141–142) and its destructure/default (~723); the `AiSuggestion` interface (152–156); `aiInstruction` / `applyingAi` state (729–730); `handleApplyAi` (991–1051); the AI `<Paper>` card JSX (1061–1107). Remove now-unused imports if nothing else in the file uses them (`AutoAwesomeIcon`, `authFetch`, `detectTitleLanguage` — grep the file for each before removing).

- [ ] **Step 2: Confirm the only other caller is unaffected**

Run: `grep -rn "enableAiRename" admin/src`
Expected: no matches (migrations.tsx never used it).

- [ ] **Step 3: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && /usr/bin/env npx tsc -p tsconfig.json --noEmit'`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add admin/src/components/SessionTrackTable.tsx
git commit -m "refactor(admin): drop SessionTrackTable's embedded AI box

Superseded by the shared AiAssistPanel. Removes enableAiRename and its
handler so there is a single AI implementation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification (backend suite + typecheck + browser pass)

**Files:** none (verification only).

- [ ] **Step 1: Full backend test suite**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'`
Expected: PASS, except the 6 known pre-existing `payment.test.ts` env-dependent failures (see project memory). Confirm no NEW failures — especially `tests/services/ai-assist.test.ts`, `tests/routes/admin/rename-tracks.test.ts`, `tests/routes/admin/upload.test.ts`.

- [ ] **Step 2: Backend + admin typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun run typecheck'`
Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && /usr/bin/env npx tsc -p tsconfig.json --noEmit'`
Expected: no errors.

- [ ] **Step 3: Browser verification (invoke the `verify`/`run` skill or drive manually)**

Start the API (`bun run dev`) + admin (`bun run dev:admin`), log in, and on **both** an event create and an event edit:
1. Type a track-only instruction ("Title-case every track title") → Ask AI → confirm the review diff shows only track changes → Apply → titles update; on edit, confirm persistence survives a refresh.
2. Type an event instruction ("Rename the event title to X") → confirm the diff shows the event change; on edit, Apply then Save, refresh, confirm persisted.
3. Type a session instruction ("Title-case the session titles") → confirm the diff shows session changes → Apply.
4. Confirm an unmatched speaker shows the warning chip.
Capture a screenshot of the review diff on the edit form.

- [ ] **Step 4: Final integration commit / branch summary**

Confirm the working tree is clean (`git status`) and summarize the branch (`git log --oneline main..HEAD`). Report results; do not merge (leave the branch for review).

---

## Self-Review

**Spec coverage:** edit-form panel (Tasks 4–5) ✓; parity capabilities via shared component + service (Tasks 1,3) ✓; expanded event/session capability (Task 2) ✓; explicit-intent gating (Task 2 prompt) ✓; review-then-apply gate (Task 3 UI) ✓; de-dup two handlers (Task 1) ✓; localization (Task 3) ✓; event-field scope titles/mainThemes/sessionThemes/dates, no relations (Task 2 schema) ✓; date validation (Task 2) ✓; non-destructive (service returns suggestions; host applies) ✓; testing on backend, browser verify for frontend given no admin test harness (Task 7 + Global Constraints) ✓.

**Placeholder scan:** none — all code blocks are concrete. Two guarded "verify the actual field names" notes (Tasks 4–5) are correctness checks against `InferredSession`/`ParsedTrack`, not deferred work.

**Type consistency:** `RenameTrackRow`/`RenameSuggestion` defined in Task 1 reused in Task 2 ✓; `AiAssistResult`/`AiAssistEventFields` defined in Task 3 reused in Tasks 4–5 ✓; rowKey conventions — create sessions `s${i}` / tracks `fileKey(file)` (Task 4) match the apply handler (Task 4); edit sessions/tracks `String(id)` (Task 5) match the apply handler (Task 5) ✓; endpoints match the mounted routes `/api/admin/upload/rename-tracks` and `/api/admin/events/:id/rename-tracks` ✓.
