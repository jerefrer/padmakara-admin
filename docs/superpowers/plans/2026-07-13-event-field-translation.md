# Event-Level In-Form Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin translate an event's **title**, **main themes**, and **session themes** between EN↔PT directly in the new/edit event form, with each AI-generated value flagged "unreviewed" until a human confirms it.

**Architecture:** A new stateless backend endpoint `POST /api/admin/translate` calls Claude Haiku (with the existing Buddhist-terminology glossary) and returns translated text without touching the DB — so it works on unsaved *create* forms. The admin form calls it via a small `translateFields` helper, writes results into local form state, and marks the target field `reviewed = false`. Six new `*_reviewed` boolean columns on the `retreats` (events) table persist review state through the existing event create/update routes. The app is **not** touched by this plan.

**Tech Stack:** Hono + Drizzle + Bun (backend), Vitest (backend tests), React-admin + MUI + `useState` (admin UI, no test framework), Anthropic Claude Haiku, Zod v4.

## Global Constraints

- **Spec:** `padmakara-api/docs/superpowers/specs/2026-07-13-event-form-translation-design.md`.
- **This is Plan 1 of 3.** Plan 2 = session-title translation (also adds missing session-edit persistence). Plan 3 = adaptive track titles + app. They reuse this plan's `/api/admin/translate` endpoint. Do **not** implement session/track titles here.
- **Only the normal new/edit event form** (`EventFormFields`, used by both `EventCreate` and `EventEdit`). Do **not** touch the bulk-import / Migration / LegacyImports flow or `SessionTrackTable`.
- **Migrations only, never `db:push`.** Hand-write SQL under `src/db/migrations/`, use `ADD COLUMN IF NOT EXISTS`, and append a matching `meta/_journal.json` entry. Highest existing migration is `0027`.
- **`reviewed` is admin-only metadata.** The app never reads it; unreviewed translations still display. Default `true` for all existing/hand-typed content.
- **Model:** `claude-haiku-4-5-20251001`. **API key:** `process.env.ANTHROPIC_API_KEY` (missing → 500 `INTERNAL_ERROR`).
- **Error codes** (from `src/lib/errors.ts`): `AppError.badRequest(msg, "VALIDATION_ERROR")` → 400; `AppError.internal(msg)` → 500 `INTERNAL_ERROR`. Zod failures thrown as `badRequest(..., "VALIDATION_ERROR")`.
- **Zod v4:** `import { z } from "zod"`.
- **Run backend tests** (zoxide hijacks `cd`, so use `sh -c`):
  `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun test <path>'`
- **Admin UI has no test framework** — verify admin changes with `sh -c 'cd .../padmakara-api/admin && npx tsc -b'` plus the manual checks each task lists.
- **Conventional Commits**, imperative, lowercase, no trailing period.

---

## File Structure

**New files**
- `padmakara-api/src/routes/admin/translate.ts` — the stateless translate endpoint (one responsibility: text-in → translated-text-out).
- `padmakara-api/tests/routes/admin/translate.test.ts` — endpoint tests.
- `padmakara-api/src/db/migrations/0028_event_translation_review_flags.sql` — 6 boolean columns on `retreats`.
- `padmakara-api/admin/src/utils/translateFields.ts` — admin client for the endpoint.

**Modified files**
- `padmakara-api/src/routes/admin/index.ts` — register the new route.
- `padmakara-api/src/routes/admin/events.ts` — **remove** the unused id-bound `translate-themes` handler.
- `padmakara-api/src/db/schema/retreats.ts` — 6 Drizzle boolean columns.
- `padmakara-api/src/db/migrations/meta/_journal.json` — journal entry for `0028`.
- `padmakara-api/src/lib/schemas.ts` — 6 optional booleans on `createEventSchema`.
- `padmakara-api/admin/src/resources/events.tsx` — `EventFormData`, `EMPTY_FORM`, `EventEdit` load effect, `updateField`, and the `EventFormFields` title + themes UI.
- `padmakara-api/admin/src/i18n/en.ts`, `padmakara-api/admin/src/i18n/pt.ts` — new label keys.

---

## Task 1: Stateless translate endpoint

**Files:**
- Create: `padmakara-api/src/routes/admin/translate.ts`
- Create: `padmakara-api/tests/routes/admin/translate.test.ts`
- Modify: `padmakara-api/src/routes/admin/index.ts` (register)
- Modify: `padmakara-api/src/routes/admin/events.ts` (remove `translate-themes`)

**Interfaces:**
- Produces: `POST /api/admin/translate` — body `{ direction: "en-to-pt" | "pt-to-en", items: Record<string,string> }` (items non-empty), returns `{ translations: Record<string,string> }` keyed identically to `items`. 400 `VALIDATION_ERROR` for bad/empty input, 500 `INTERNAL_ERROR` for missing key / unparseable model output, 401/403 from admin middleware.

- [ ] **Step 1: Write the failing test**

Create `padmakara-api/tests/routes/admin/translate.test.ts` (mirrors the existing `tests/routes/admin/rename-tracks.test.ts` mock style):

```ts
/**
 * Tests for POST /api/admin/translate — the stateless EN<->PT translate
 * endpoint. The route validates the body and calls Anthropic; the DB mock
 * only needs to satisfy the auth middleware's user lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
    select: vi.fn(),
  },
}));

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { createAccessToken } from "../../../src/services/auth.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}
function anthropicResponse(jsonText: string) {
  return { content: [{ type: "text", text: jsonText }] };
}

describe("POST /api/admin/translate", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key-123" };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns translations keyed like the input items", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      anthropicResponse(JSON.stringify({ title: "Retiro de Primavera" })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "Spring Retreat" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ title: "Retiro de Primavera" });
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("strips markdown code fences around the JSON", async () => {
    const withFences = "```json\n" + JSON.stringify({ title: "Olá" }) + "\n```";
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse(withFences));
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "Hello" } }),
    });
    expect(status).toBe(200);
    expect((body as any).translations).toEqual({ title: "Olá" });
  });

  it("returns 400 for an invalid direction", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "es-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for empty items", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: {} }),
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });
    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when the model output is not parseable JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse("Sorry, cannot."));
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
  });

  it("returns 500 when model output is valid JSON but not an object of strings", async () => {
    mockMessagesCreate.mockResolvedValueOnce(anthropicResponse(JSON.stringify({ title: 42 })));
    const token = await adminToken();
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(500);
  });

  it("returns 401 without a token", async () => {
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/translate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: "en-to-pt", items: { title: "x" } }),
    });
    expect(status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun test tests/routes/admin/translate.test.ts'`
Expected: FAIL — the route does not exist yet, so requests 404 (assertions on 200/400/500 fail).

- [ ] **Step 3: Create the endpoint**

Create `padmakara-api/src/routes/admin/translate.ts`:

```ts
import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "../../lib/errors.ts";
import { glossaryBlock } from "../../services/glossary.ts";

const translateRoutes = new Hono();

// Short admin fields (titles, theme summaries) — Haiku is fast and cheap and
// matches the model used by the other admin text-rewrite endpoints.
const TRANSLATE_MODEL = "claude-haiku-4-5-20251001";

const translateSchema = z.object({
  direction: z.enum(["en-to-pt", "pt-to-en"]),
  items: z
    .record(z.string(), z.string())
    .refine((o) => Object.keys(o).length > 0, "items must contain at least one field"),
});

/**
 * POST /admin/translate — stateless EN<->PT translation.
 *
 * Takes an opaque map of field key -> source text and returns the same keys
 * mapped to translated text. It performs no DB writes and needs no event id,
 * so the admin form can call it on an unsaved (create) event.
 */
translateRoutes.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw AppError.badRequest("Invalid JSON body", "VALIDATION_ERROR");
  }
  const parsed = translateSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.badRequest("Validation failed", "VALIDATION_ERROR");
  }
  const { direction, items } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const fromLang = direction === "en-to-pt" ? "English" : "Portuguese";
  const toLang = direction === "en-to-pt" ? "Portuguese" : "English";

  const anthropic = new Anthropic({ apiKey });
  const prompt = Object.entries(items)
    .map(([key, source]) => `### ${key}\n${source}`)
    .join("\n\n");

  const message = await anthropic.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 4096,
    system:
      `You are translating Buddhist teaching materials from ${fromLang} to European ${toLang}. ` +
      `Preserve Buddhist terminology (dharma names, Sanskrit/Tibetan terms). Maintain structure and formatting.\n\n` +
      `${glossaryBlock()}\n\n` +
      `Respond ONLY with a JSON object mapping each input field key to its translated text. ` +
      `Example: {"title": "..."}`,
    messages: [
      {
        role: "user",
        content: `Translate the following fields from ${fromLang} to ${toLang}:\n\n${prompt}`,
      },
    ],
  });

  const textBlock = message.content.find((b: any) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from translation API");
  }
  let responseText = (textBlock as any).text.trim();
  if (responseText.startsWith("```")) {
    responseText = responseText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  let translations: unknown;
  try {
    translations = JSON.parse(responseText);
  } catch {
    throw AppError.internal("Failed to parse translation response");
  }
  const result = z.record(z.string(), z.string()).safeParse(translations);
  if (!result.success) {
    throw AppError.internal("Translation response was not an object of strings");
  }

  return c.json({ translations: result.data });
});

export { translateRoutes };
```

- [ ] **Step 4: Register the route**

In `padmakara-api/src/routes/admin/index.ts`, add the import after the other route imports (near line 60):

```ts
import { translateRoutes } from "./translate.ts";
```

and mount it alongside the other `admin.route(...)` calls (e.g. after the `admin.route("/tracks", trackRoutes);` line):

```ts
admin.route("/translate", translateRoutes);
```

- [ ] **Step 5: Remove the unused id-bound `translate-themes` handler**

In `padmakara-api/src/routes/admin/events.ts`, delete the entire `eventRoutes.post("/:id/translate-themes", async (c) => { ... });` handler (currently ~lines 285–410, ending at its closing `});`). Leave the surrounding handlers intact. `Anthropic` is still imported at the top of that file and used by other handlers, so do not remove the import.

- [ ] **Step 6: Run tests to verify they pass**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun test tests/routes/admin/translate.test.ts'`
Expected: PASS (all cases).

- [ ] **Step 7: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add padmakara-api/src/routes/admin/translate.ts padmakara-api/tests/routes/admin/translate.test.ts padmakara-api/src/routes/admin/index.ts padmakara-api/src/routes/admin/events.ts
git commit -m "feat(admin): add stateless /admin/translate endpoint"
```

---

## Task 2: Event translation-review columns (DB + schema + validation)

**Files:**
- Create: `padmakara-api/src/db/migrations/0028_event_translation_review_flags.sql`
- Modify: `padmakara-api/src/db/schema/retreats.ts`
- Modify: `padmakara-api/src/db/migrations/meta/_journal.json`
- Modify: `padmakara-api/src/lib/schemas.ts`

**Interfaces:**
- Produces: 6 boolean columns on `retreats` — `title_en_reviewed`, `title_pt_reviewed`, `main_themes_en_reviewed`, `main_themes_pt_reviewed`, `session_themes_en_reviewed`, `session_themes_pt_reviewed` (Drizzle: `titleEnReviewed`, `titlePtReviewed`, `mainThemesEnReviewed`, `mainThemesPtReviewed`, `sessionThemesEnReviewed`, `sessionThemesPtReviewed`), all `NOT NULL DEFAULT true`, accepted as optional booleans by `createEventSchema`/`updateEventSchema`.

- [ ] **Step 1: Write the migration SQL**

Create `padmakara-api/src/db/migrations/0028_event_translation_review_flags.sql`:

```sql
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "main_themes_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "main_themes_pt_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "session_themes_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "session_themes_pt_reviewed" boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: Append the journal entry**

Open `padmakara-api/src/db/migrations/meta/_journal.json`. Copy the **last** entry in the `entries` array, append a new one that is identical in shape except: `idx` = the previous entry's idx + 1 (should be `28`), `tag` = `"0028_event_translation_review_flags"`, and `when` = the current epoch-milliseconds integer. Keep the same `version` and `breakpoints` values the other entries use.

- [ ] **Step 3: Add the Drizzle columns**

In `padmakara-api/src/db/schema/retreats.ts`, first ensure `boolean` is imported from `drizzle-orm/pg-core` (add it to the existing import list if missing). Then, inside the `events` table object, immediately after the `sessionThemesPt: text("session_themes_pt"),` line, add:

```ts
  titleEnReviewed: boolean("title_en_reviewed").notNull().default(true),
  titlePtReviewed: boolean("title_pt_reviewed").notNull().default(true),
  mainThemesEnReviewed: boolean("main_themes_en_reviewed").notNull().default(true),
  mainThemesPtReviewed: boolean("main_themes_pt_reviewed").notNull().default(true),
  sessionThemesEnReviewed: boolean("session_themes_en_reviewed").notNull().default(true),
  sessionThemesPtReviewed: boolean("session_themes_pt_reviewed").notNull().default(true),
```

- [ ] **Step 4: Add the Zod fields**

In `padmakara-api/src/lib/schemas.ts`, inside `createEventSchema`'s object (after `sessionThemesPt: z.string().optional().nullable(),`), add:

```ts
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
  mainThemesEnReviewed: z.boolean().optional(),
  mainThemesPtReviewed: z.boolean().optional(),
  sessionThemesEnReviewed: z.boolean().optional(),
  sessionThemesPtReviewed: z.boolean().optional(),
```

`updateEventSchema` is `createEventSchema.partial()`, so it inherits these automatically. The event POST spreads `...eventData` and the PUT filters by sent keys, so these pass through to the DB with no route change.

- [ ] **Step 5: Apply the migration**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun db:migrate'`
Expected: migration `0028_event_translation_review_flags` applies with no error (idempotent `IF NOT EXISTS`).

- [ ] **Step 6: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add padmakara-api/src/db/migrations/0028_event_translation_review_flags.sql padmakara-api/src/db/migrations/meta/_journal.json padmakara-api/src/db/schema/retreats.ts padmakara-api/src/lib/schemas.ts
git commit -m "feat(db): add event translation-review flag columns"
```

---

## Task 3: Admin translate client helper

**Files:**
- Create: `padmakara-api/admin/src/utils/translateFields.ts`

**Interfaces:**
- Produces: `translateFields(direction: "en-to-pt" | "pt-to-en", items: Record<string,string>): Promise<Record<string,string>>` and the exported type `TranslateDirection`. Throws `Error` on non-2xx.

- [ ] **Step 1: Create the helper**

Create `padmakara-api/admin/src/utils/translateFields.ts`:

```ts
import { authFetch } from "./authFetch";

const API_URL = "/api/admin";

export type TranslateDirection = "en-to-pt" | "pt-to-en";

/**
 * Translate a set of fields EN<->PT via the stateless admin translate endpoint.
 * `items` maps an arbitrary field key to its source text; the resolved object
 * maps the same keys to translated text.
 */
export async function translateFields(
  direction: TranslateDirection,
  items: Record<string, string>,
): Promise<Record<string, string>> {
  const res = await authFetch(`${API_URL}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, items }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Translation failed (${res.status})`);
  }
  const data = (await res.json()) as { translations: Record<string, string> };
  return data.translations;
}
```

- [ ] **Step 2: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && npx tsc -b'`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add padmakara-api/admin/src/utils/translateFields.ts
git commit -m "feat(admin): add translateFields client helper"
```

---

## Task 4: Form state plumbing for reviewed flags

**Files:**
- Modify: `padmakara-api/admin/src/resources/events.tsx` — `EventFormData` (~L458), `EMPTY_FORM` (~L478), `EventEdit` load effect (~L1712), `updateField` (~L575).

**Interfaces:**
- Consumes: none.
- Produces: `EventFormData` gains 6 booleans (`titleEnReviewed`, `titlePtReviewed`, `mainThemesEnReviewed`, `mainThemesPtReviewed`, `sessionThemesEnReviewed`, `sessionThemesPtReviewed`); a module-level `REVIEWED_KEY` map used by Task 6; `updateField` sets the matching `*Reviewed` flag to `true` on manual edit.

- [ ] **Step 1: Extend `EventFormData`**

In `EventFormData`, after `sessionThemesPt: string;`, add:

```tsx
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
  mainThemesEnReviewed: boolean;
  mainThemesPtReviewed: boolean;
  sessionThemesEnReviewed: boolean;
  sessionThemesPtReviewed: boolean;
```

- [ ] **Step 2: Extend `EMPTY_FORM`**

In `EMPTY_FORM`, add (before the closing `}`):

```tsx
  titleEnReviewed: true, titlePtReviewed: true,
  mainThemesEnReviewed: true, mainThemesPtReviewed: true,
  sessionThemesEnReviewed: true, sessionThemesPtReviewed: true,
```

- [ ] **Step 3: Load reviewed flags in `EventEdit`**

In the `EventEdit` load `useEffect`, inside the `setForm({ ... })` object (after `featuredAt: event.featuredAt || null,`), add:

```tsx
      titleEnReviewed: event.titleEnReviewed ?? true,
      titlePtReviewed: event.titlePtReviewed ?? true,
      mainThemesEnReviewed: event.mainThemesEnReviewed ?? true,
      mainThemesPtReviewed: event.mainThemesPtReviewed ?? true,
      sessionThemesEnReviewed: event.sessionThemesEnReviewed ?? true,
      sessionThemesPtReviewed: event.sessionThemesPtReviewed ?? true,
```

- [ ] **Step 4: Add the `REVIEWED_KEY` map and mark manual edits reviewed**

Add this map at module scope, next to `syncedRows` (near L524):

```tsx
/** Text fields that have a companion `<field>Reviewed` boolean. Editing one of
 *  these by hand marks it reviewed; translating INTO one marks it unreviewed. */
const REVIEWED_KEY: Partial<Record<keyof EventFormData, keyof EventFormData>> = {
  titleEn: "titleEnReviewed",
  titlePt: "titlePtReviewed",
  mainThemesEn: "mainThemesEnReviewed",
  mainThemesPt: "mainThemesPtReviewed",
  sessionThemesEn: "sessionThemesEnReviewed",
  sessionThemesPt: "sessionThemesPtReviewed",
};
```

Then replace the body of `updateField` (inside `EventFormFields`) with:

```tsx
  const updateField =
    (field: keyof EventFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      const reviewedKey = REVIEWED_KEY[field];
      setForm((prev) => ({
        ...prev,
        [field]: value,
        ...(reviewedKey ? { [reviewedKey]: true } : {}),
      }));
    };
```

- [ ] **Step 5: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && npx tsc -b'`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add padmakara-api/admin/src/resources/events.tsx
git commit -m "feat(admin): track per-field translation-review state in the event form"
```

---

## Task 5: i18n labels

**Files:**
- Modify: `padmakara-api/admin/src/i18n/en.ts` (inside `padmakara.events`)
- Modify: `padmakara-api/admin/src/i18n/pt.ts` (inside `padmakara.events`)

**Interfaces:**
- Produces: keys `padmakara.events.translateToPt`, `translateToEn`, `translateAllToPt`, `translateAllToEn`, `aiUnreviewed`, `markReviewed`, `translateNothing`, `translateError` (consumed by Task 6).

- [ ] **Step 1: Add English labels**

In `padmakara-api/admin/src/i18n/en.ts`, inside the `padmakara.events` object (e.g. right after `sessionThemesPlaceholderPt`), add:

```ts
      translateToPt: "→ Portuguese",
      translateToEn: "→ English",
      translateAllToPt: "Translate all → Portuguese",
      translateAllToEn: "Translate all → English",
      aiUnreviewed: "AI · unreviewed",
      markReviewed: "Mark reviewed",
      translateNothing: "Nothing to translate — target fields already filled",
      translateError: "Translation failed",
```

- [ ] **Step 2: Add Portuguese labels**

In `padmakara-api/admin/src/i18n/pt.ts`, inside the matching `padmakara.events` object, add:

```ts
      translateToPt: "→ Português",
      translateToEn: "→ Inglês",
      translateAllToPt: "Traduzir tudo → Português",
      translateAllToEn: "Traduzir tudo → Inglês",
      aiUnreviewed: "IA · por rever",
      markReviewed: "Marcar como revisto",
      translateNothing: "Nada a traduzir — os campos de destino já estão preenchidos",
      translateError: "Falha na tradução",
```

- [ ] **Step 3: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && npx tsc -b'`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add padmakara-api/admin/src/i18n/en.ts padmakara-api/admin/src/i18n/pt.ts
git commit -m "i18n(admin): add translate/review labels for the event form"
```

---

## Task 6: Translate buttons + reviewed chips in `EventFormFields`

**Files:**
- Modify: `padmakara-api/admin/src/resources/events.tsx` — imports, `EventFormFields` body (handlers), the Title `Paper` (~L649) and the Themes `Paper` (~L839).

**Interfaces:**
- Consumes: `translateFields` + `TranslateDirection` (Task 3), `EventFormData` reviewed fields + `REVIEWED_KEY` (Task 4), i18n keys (Task 5).
- Produces: per-pair translate buttons + a global "translate all" pair on the title/themes fields, each source field showing an "AI · unreviewed" chip with a "Mark reviewed" action.

- [ ] **Step 1: Add imports**

Ensure these are imported at the top of `events.tsx` (add any that are missing; `Box`/`Button`/`useNotify` are likely already present — check before adding to avoid duplicates):

```tsx
import { Chip, CircularProgress } from "@mui/material";
```
```tsx
import { translateFields, type TranslateDirection } from "../utils/translateFields";
```

`Box`, `Button`, `Paper`, `Grid`, `MuiTextField` are already imported from `@mui/material`; `useNotify` from `react-admin` (the file already uses `notify` in `handleSave`). If `useNotify`/`notify` is not in scope inside `EventFormFields`, add `const notify = useNotify();` at the top of the component (Step 2 assumes `notify` exists).

- [ ] **Step 2: Add state + handlers inside `EventFormFields`**

Immediately after the `updateField` definition (from Task 4), add:

```tsx
  const notify = useNotify();
  // Which field (or "all") is currently being translated — drives spinners/disabled.
  const [translating, setTranslating] = useState<string | null>(null);

  const translateOne = async (
    sourceField: keyof EventFormData,
    targetField: keyof EventFormData,
    targetReviewedField: keyof EventFormData,
    direction: TranslateDirection,
  ) => {
    const source = String(form[sourceField] ?? "").trim();
    if (!source) return;
    setTranslating(sourceField as string);
    try {
      const out = await translateFields(direction, { [targetField as string]: source });
      const translated = out[targetField as string] ?? "";
      setForm((prev) => ({ ...prev, [targetField]: translated, [targetReviewedField]: false }));
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslating(null);
    }
  };

  const translateAllMissing = async (direction: TranslateDirection) => {
    // [sourceField, targetField, targetReviewedField]
    const pairs: Array<[keyof EventFormData, keyof EventFormData, keyof EventFormData]> =
      direction === "en-to-pt"
        ? [
            ["titleEn", "titlePt", "titlePtReviewed"],
            ["mainThemesEn", "mainThemesPt", "mainThemesPtReviewed"],
            ["sessionThemesEn", "sessionThemesPt", "sessionThemesPtReviewed"],
          ]
        : [
            ["titlePt", "titleEn", "titleEnReviewed"],
            ["mainThemesPt", "mainThemesEn", "mainThemesEnReviewed"],
            ["sessionThemesPt", "sessionThemesEn", "sessionThemesEnReviewed"],
          ];
    const items: Record<string, string> = {};
    const targetOf: Record<string, keyof EventFormData> = {};
    const reviewedOf: Record<string, keyof EventFormData> = {};
    for (const [src, tgt, rev] of pairs) {
      const source = String(form[src] ?? "").trim();
      const target = String(form[tgt] ?? "").trim();
      if (source && !target) {
        const k = tgt as string;
        items[k] = source;
        targetOf[k] = tgt;
        reviewedOf[k] = rev;
      }
    }
    if (Object.keys(items).length === 0) {
      notify(translate("padmakara.events.translateNothing"), { type: "info" });
      return;
    }
    setTranslating("all");
    try {
      const out = await translateFields(direction, items);
      setForm((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(out)) {
          (next as any)[targetOf[key]] = out[key];
          (next as any)[reviewedOf[key]] = false;
        }
        return next;
      });
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslating(null);
    }
  };

  // Render the translate button + unreviewed chip that sit under one field.
  // `direction` translates THIS field into the OTHER field.
  const fieldControls = (
    thisField: keyof EventFormData,
    otherField: keyof EventFormData,
    otherReviewedField: keyof EventFormData,
    thisReviewedField: keyof EventFormData,
    direction: TranslateDirection,
    translateLabelKey: string,
  ) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5, minHeight: 30 }}>
      <Button
        size="small"
        variant="text"
        disabled={!String(form[thisField] ?? "").trim() || translating !== null}
        startIcon={translating === (thisField as string) ? <CircularProgress size={14} /> : undefined}
        onClick={() => translateOne(thisField, otherField, otherReviewedField, direction)}
      >
        {translate(translateLabelKey)}
      </Button>
      {!form[thisReviewedField] && (
        <>
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={translate("padmakara.events.aiUnreviewed")}
          />
          <Button
            size="small"
            variant="text"
            onClick={() => setForm((prev) => ({ ...prev, [thisReviewedField]: true }))}
          >
            {translate("padmakara.events.markReviewed")}
          </Button>
        </>
      )}
    </Box>
  );
```

- [ ] **Step 3: Add the global buttons + per-field controls to the Title Paper**

In the Title `Paper` block, add a global toolbar as the first child of the `Paper` (before the `<Grid container ...>`):

```tsx
        <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
          <Button size="small" variant="outlined" disabled={translating !== null}
            onClick={() => translateAllMissing("en-to-pt")}>
            {translate("padmakara.events.translateAllToPt")}
          </Button>
          <Button size="small" variant="outlined" disabled={translating !== null}
            onClick={() => translateAllMissing("pt-to-en")}>
            {translate("padmakara.events.translateAllToEn")}
          </Button>
        </Box>
```

Then, inside the title EN `<Grid size=...>` item, immediately after its `</MuiTextField>`'s closing (i.e. after the `titleEn` field), add:

```tsx
            {fieldControls("titleEn", "titlePt", "titlePtReviewed", "titleEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
```

and inside the title PT `<Grid>` item after the `titlePt` field:

```tsx
            {fieldControls("titlePt", "titleEn", "titleEnReviewed", "titlePtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
```

- [ ] **Step 4: Add per-field controls to the Themes Paper**

In the Themes `Paper` block, after each theme `MuiTextField`, inside its `<Grid>` item, add the matching control line:

- after `mainThemesEn`:
```tsx
            {fieldControls("mainThemesEn", "mainThemesPt", "mainThemesPtReviewed", "mainThemesEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
```
- after `mainThemesPt`:
```tsx
            {fieldControls("mainThemesPt", "mainThemesEn", "mainThemesEnReviewed", "mainThemesPtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
```
- after `sessionThemesEn`:
```tsx
            {fieldControls("sessionThemesEn", "sessionThemesPt", "sessionThemesPtReviewed", "sessionThemesEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
```
- after `sessionThemesPt`:
```tsx
            {fieldControls("sessionThemesPt", "sessionThemesEn", "sessionThemesEnReviewed", "sessionThemesPtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
```

- [ ] **Step 5: Typecheck**

Run: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && npx tsc -b'`
Expected: no errors.

- [ ] **Step 6: Manual verification (no admin test framework)**

Start the API (`sh -c 'cd .../padmakara-api && bun run dev'`) and admin (`sh -c 'cd .../padmakara-api && bun run dev:admin'`), set `ANTHROPIC_API_KEY` in `padmakara-api/.env`, then in the admin **New Event** form:
1. Type an English title → click **→ Portuguese** → the PT title fills and shows an amber **AI · unreviewed** chip.
2. Click **Mark reviewed** → chip disappears.
3. Edit the PT title by hand → it stays reviewed (no chip).
4. Fill only the English main/session themes → click **Translate all → Portuguese** → empty PT targets fill (already-filled ones are skipped) and show chips.
5. Save the event, reopen it in **Edit** → the chips reflect the saved reviewed state (unreviewed fields still show a chip).
6. Confirm the translated (unreviewed) event still renders in the app if published — reviewed state does not gate display.

- [ ] **Step 7: Commit**

```bash
git add padmakara-api/admin/src/resources/events.tsx
git commit -m "feat(admin): translate event title and themes in-form with review flags"
```

---

## Self-Review (completed by plan author)

**Spec coverage (this plan's slice):** event title + main themes + session themes translation ✔ (Tasks 1, 3, 6); per-field + global controls ✔ (Task 6); stateless endpoint replacing `translate-themes` ✔ (Task 1); reviewed per-side boolean columns default `true`, admin-only ✔ (Tasks 2, 4, 6); Haiku + glossary ✔ (Task 1); migration `0028` via hand-written SQL + journal ✔ (Task 2). **Deferred to Plan 2/3 (spec sections explicitly carved out):** session-title translation + session-edit persistence; track `title_en/title_pt` + adaptive app rendering + track reviewed columns.

**Placeholder scan:** none — every step carries the actual code or an exact, mechanical instruction (journal entry derives from the existing last entry).

**Type consistency:** `translateFields(direction, items)` / `TranslateDirection` are used identically in Tasks 3 and 6; the 6 `*Reviewed` names match across the Drizzle schema (Task 2), Zod (Task 2), `EventFormData`/`EMPTY_FORM`/load-effect (Task 4), and `fieldControls` call sites (Task 6); `REVIEWED_KEY` defined in Task 4 is only read by `updateField` (Task 4).
