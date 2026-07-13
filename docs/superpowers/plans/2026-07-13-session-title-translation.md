# Session-Title Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin enter and translate **each session's title** in EN and PT in the new/edit event form, with a per-side `reviewed` flag — and make session-title edits actually persist in edit mode (they currently do not).

**Architecture:** Reuses the `POST /api/admin/translate` endpoint and the `translateFields` helper built in Plan 1. Adds a `title_pt`-alongside review model to the `sessions` table (two `*_reviewed` boolean columns), teaches the admin's `InferredSession` model + `SessionPreview`/`SessionCard` to edit EN/PT session titles with translate buttons and reviewed chips, and — the pre-existing gap — adds session-edit persistence to `EventEdit` (mirroring the existing `handleTrackUpdate`). The app already reads `sessions.titleEn/titlePt` via `mapSession.name_translations`, so **no app change** is needed.

**Tech Stack:** Hono + Drizzle + Bun, React-admin + MUI + `useState`, Anthropic Claude Haiku, Zod v4.

## Global Constraints

- **Spec:** `padmakara-api/docs/superpowers/specs/2026-07-13-event-form-translation-design.md`.
- **Depends on Plan 1** (`2026-07-13-event-field-translation.md`): the `/api/admin/translate` endpoint and `admin/src/utils/translateFields.ts` must already exist. Do Plan 1 first.
- **This is Plan 2 of 3.** Plan 3 = adaptive combined-track titles + app.
- **Only the normal new/edit form** (`EventFormFields` → `SessionPreview`). Do not touch the bulk-import / `SessionTrackTable` path.
- **Migrations only, never `db:push`.** Hand-write SQL, `ADD COLUMN IF NOT EXISTS`, append `meta/_journal.json`. This plan uses migration `0029` (Plan 1 used `0028`).
- **`reviewed` is admin-only** (default `true`); the app never reads it.
- **Session title fields already exist on the DB** (`sessions.title_en`, `sessions.title_pt`) and in Zod (`createSessionSchema`/`updateSessionSchema` already accept `titleEn`/`titlePt`). This plan only adds the two `*_reviewed` columns + the admin UI + persistence.
- Backend tests via `sh -c 'cd .../padmakara-api && bun test <path>'`; admin typecheck via `sh -c 'cd .../padmakara-api/admin && npx tsc -b'`. Admin UI has **no** test framework — verify manually.
- **Conventional Commits.**

---

## File Structure

**New**
- `padmakara-api/src/db/migrations/0029_session_translation_review_flags.sql`

**Modified**
- `padmakara-api/src/db/schema/sessions.ts` — 2 boolean columns.
- `padmakara-api/src/db/migrations/meta/_journal.json` — journal entry for `0029`.
- `padmakara-api/src/lib/schemas.ts` — 2 optional booleans on `createSessionSchema`.
- `padmakara-api/admin/src/utils/trackParser.ts` — `InferredSession` gains `titlePt` + 2 reviewed flags.
- `padmakara-api/admin/src/resources/events.tsx` — `toInferredSessions` reads new fields; `EventFormProps.onSessionTitleChange` becomes a patch; `EventCreate`/`EventEdit` session handlers; `EventCreate` `handleSave` session-create payload.
- `padmakara-api/admin/src/components/SessionPreview.tsx` — `SessionPreviewProps`/`SessionCardProps` signature; EN/PT session-title edit UI with translate + reviewed.
- `padmakara-api/admin/src/i18n/en.ts`, `pt.ts` — session-title label.

---

## Task 1: Session translation-review columns (DB + schema + validation)

**Files:**
- Create: `padmakara-api/src/db/migrations/0029_session_translation_review_flags.sql`
- Modify: `padmakara-api/src/db/schema/sessions.ts`, `padmakara-api/src/db/migrations/meta/_journal.json`, `padmakara-api/src/lib/schemas.ts`

**Interfaces:**
- Produces: `sessions.title_en_reviewed`, `sessions.title_pt_reviewed` (Drizzle `titleEnReviewed`/`titlePtReviewed`), `NOT NULL DEFAULT true`; accepted as optional booleans by `createSessionSchema`/`updateSessionSchema`.

- [ ] **Step 1: Migration SQL** — create `0029_session_translation_review_flags.sql`:

```sql
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: Journal entry** — in `meta/_journal.json`, copy the last entry, set `idx` = previous + 1 (`29`), `tag` = `"0029_session_translation_review_flags"`, `when` = current epoch-ms, keep the same `version`/`breakpoints`.

- [ ] **Step 3: Drizzle columns** — in `sessions.ts`, ensure `boolean` is imported from `drizzle-orm/pg-core`, then after `titlePt: text("title_pt"),` add:

```ts
    titleEnReviewed: boolean("title_en_reviewed").notNull().default(true),
    titlePtReviewed: boolean("title_pt_reviewed").notNull().default(true),
```

- [ ] **Step 4: Zod fields** — in `src/lib/schemas.ts`, inside `createSessionSchema` (after `titlePt: z.string().max(200).optional().nullable(),`) add:

```ts
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
```

`updateSessionSchema = createSessionSchema.partial()` inherits them. The session PUT does `.set({ ...data })`, so they persist with no route change.

- [ ] **Step 5: Apply** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun db:migrate'` → applies cleanly.

- [ ] **Step 6: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'` → no errors.

- [ ] **Step 7: Commit**

```bash
git add padmakara-api/src/db/migrations/0029_session_translation_review_flags.sql padmakara-api/src/db/migrations/meta/_journal.json padmakara-api/src/db/schema/sessions.ts padmakara-api/src/lib/schemas.ts
git commit -m "feat(db): add session translation-review flag columns"
```

---

## Task 2: Extend the admin `InferredSession` model

**Files:**
- Modify: `padmakara-api/admin/src/utils/trackParser.ts` — `InferredSession`
- Modify: `padmakara-api/admin/src/resources/events.tsx` — `toInferredSessions` (~L1642)

**Interfaces:**
- Consumes: none.
- Produces: `InferredSession` gains `titlePt: string`, `titleEnReviewed: boolean`, `titlePtReviewed: boolean`; `toInferredSessions` populates them from the DB session row.

- [ ] **Step 1: Extend the interface** — in `trackParser.ts`, inside `InferredSession`, after `titleEn: string;` add:

```ts
  titlePt: string;
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
```

- [ ] **Step 2: Populate from the DB** — in `toInferredSessions` (`events.tsx`), inside the mapped session object, after `titleEn: s.titleEn || \`Session ${s.sessionNumber}\`,` add:

```ts
    titlePt: s.titlePt || "",
    titleEnReviewed: s.titleEnReviewed ?? true,
    titlePtReviewed: s.titlePtReviewed ?? true,
```

- [ ] **Step 3: Seed new (create-flow) sessions** — search `events.tsx` for every place that constructs an `InferredSession` literal for a *new* session (the file inserts `titleEn: "New session"` / builds sessions from parsed files; TypeScript will now flag each literal missing `titlePt`/reviewed). For each, add `titlePt: "", titleEnReviewed: true, titlePtReviewed: true,`. Let the typecheck in Step 4 enumerate them.

- [ ] **Step 4: Typecheck** — `sh -c 'cd .../padmakara-api/admin && npx tsc -b'`. Fix each "missing property" error by adding the three fields to that session literal. Repeat until clean.

- [ ] **Step 5: Commit**

```bash
git add padmakara-api/admin/src/utils/trackParser.ts padmakara-api/admin/src/resources/events.tsx
git commit -m "feat(admin): add PT title + review flags to the session model"
```

---

## Task 3: Session-change callback becomes a patch + persistence

**Files:**
- Modify: `padmakara-api/admin/src/resources/events.tsx` — `EventFormProps.onSessionTitleChange`, `EventCreate` session handler, `EventEdit` session handler (`handleSessionTitleChange` ~L1760), `EventCreate` `handleSave` session-create payload (~L1351).
- Modify: `padmakara-api/admin/src/components/SessionPreview.tsx` — `SessionPreviewProps.onSessionTitleChange`, `SessionCardProps.onTitleChange`, and the `onTitleChange={(title) => onSessionTitleChange(idx, title)}` wiring (~L149).

**Interfaces:**
- Consumes: `InferredSession` fields (Task 2), `dataProvider`.
- Produces: `onSessionTitleChange(sessionIndex: number, patch: Partial<InferredSession>) => void` everywhere; `EventEdit` persists session patches via `dataProvider.update("sessions", …)`.

- [ ] **Step 1: Widen the prop types** — in `events.tsx` `EventFormProps`, change:

```tsx
  onSessionTitleChange: (idx: number, title: string) => void;
```
to
```tsx
  onSessionTitleChange: (idx: number, patch: Partial<InferredSession>) => void;
```

In `SessionPreview.tsx`, change `SessionPreviewProps.onSessionTitleChange` the same way, and change `SessionCardProps.onTitleChange` from `(title: string) => void` to `(patch: Partial<InferredSession>) => void`. Update the wiring at ~L149 from `onTitleChange={(title) => onSessionTitleChange(idx, title)}` to `onTitleChange={(patch) => onSessionTitleChange(idx, patch)}`.

- [ ] **Step 2: EventCreate handler (local-state merge)** — find the `EventCreate` screen's `onSessionTitleChange` handler (the create-flow one that updates local `sessions` state; it mirrors `EventEdit`'s `handleSessionTitleChange` but has no persistence). Replace its body with a patch-merge:

```tsx
  const handleSessionTitleChange = useCallback(
    (idx: number, patch: Partial<InferredSession>) => {
      setSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    },
    [],
  );
```

(If the create screen passes an inline arrow to `EventFormFields`, replace it with a reference to this `handleSessionTitleChange`.)

- [ ] **Step 3: EventEdit handler (merge + persist)** — replace `EventEdit`'s `handleSessionTitleChange` (~L1760) with:

```tsx
  const handleSessionTitleChange = useCallback(
    (idx: number, patch: Partial<InferredSession>) => {
      const session = sessions[idx];
      setSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
      // Persist immediately for existing (saved) sessions. New sessions in an
      // edit have no id yet and are handled by their own create flow.
      if (session?.id) {
        dataProvider
          .update("sessions", { id: session.id, data: patch, previousData: {} })
          .then(() => refresh())
          .catch((error: any) =>
            notify(`Error updating session: ${error.message}`, { type: "error" }),
          );
      }
    },
    [sessions, dataProvider, notify, refresh],
  );
```

(The `patch` keys — `titleEn`, `titlePt`, `titleEnReviewed`, `titlePtReviewed` — match `updateSessionSchema`, so the PUT body validates and persists.)

- [ ] **Step 4: EventCreate `handleSave` — send PT + reviewed** — in `EventCreate.handleSave`, the `dataProvider.create("sessions", { data: { … } })` call currently sends only `titleEn`. Add the PT title and review flags:

```tsx
            titleEn: session.titleEn,
            titlePt: session.titlePt || null,
            titleEnReviewed: session.titleEnReviewed,
            titlePtReviewed: session.titlePtReviewed,
```

- [ ] **Step 5: Typecheck** — `sh -c 'cd .../padmakara-api/admin && npx tsc -b'` → no errors.

- [ ] **Step 6: Commit**

```bash
git add padmakara-api/admin/src/resources/events.tsx padmakara-api/admin/src/components/SessionPreview.tsx
git commit -m "feat(admin): persist session-title edits and carry PT + review flags"
```

---

## Task 4: EN/PT session-title edit UI with translate + reviewed

**Files:**
- Modify: `padmakara-api/admin/src/components/SessionPreview.tsx` — `SessionCard` state (~L199) + the editing branch of the header (~L268).

**Interfaces:**
- Consumes: `translateFields` + `TranslateDirection` (Plan 1), `InferredSession` fields (Task 2), `onTitleChange(patch)` (Task 3), i18n keys (Task 5).
- Produces: editing a session title shows EN + PT fields, per-side translate buttons, and an "AI · unreviewed" chip with a "Mark reviewed" action; Save commits `{ titleEn, titlePt, titleEnReviewed, titlePtReviewed }`.

- [ ] **Step 1: Imports** — at the top of `SessionPreview.tsx`, ensure these exist (add missing):

```tsx
import { Chip, CircularProgress } from "@mui/material";
import { useNotify } from "react-admin";
import { translateFields, type TranslateDirection } from "../utils/translateFields";
```

- [ ] **Step 2: Replace `SessionCard`'s title edit state** — replace the single `editTitle` state (`const [editTitle, setEditTitle] = useState(session.titleEn);`) with a four-field edit object + translate state, and add `notify`:

```tsx
  const notify = useNotify();
  const [edit, setEdit] = useState({
    titleEn: session.titleEn,
    titlePt: session.titlePt,
    titleEnReviewed: session.titleEnReviewed,
    titlePtReviewed: session.titlePtReviewed,
  });
  const [translating, setTranslating] = useState<string | null>(null);

  const translateSide = async (
    source: "titleEn" | "titlePt",
    target: "titleEn" | "titlePt",
    targetReviewed: "titleEnReviewed" | "titlePtReviewed",
    direction: TranslateDirection,
  ) => {
    const text = edit[source].trim();
    if (!text) return;
    setTranslating(source);
    try {
      const out = await translateFields(direction, { [target]: text });
      setEdit((prev) => ({ ...prev, [target]: out[target] ?? "", [targetReviewed]: false }));
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslating(null);
    }
  };
```

- [ ] **Step 3: Update `handleSaveTitle`** — replace it with one that commits the whole patch:

```tsx
  const handleSaveTitle = () => {
    onTitleChange({
      titleEn: edit.titleEn,
      titlePt: edit.titlePt,
      titleEnReviewed: edit.titleEnReviewed,
      titlePtReviewed: edit.titlePtReviewed,
    });
    setEditing(false);
  };
```

- [ ] **Step 4: Replace the editing branch of the header** — the header currently renders, when `editing`, a single `<TextField value={editTitle} … />`. Replace that single `<TextField>` (the `editing ? (<TextField … />) : (<Typography>…</Typography>)` ternary's *true* branch) with a stacked EN/PT editor:

```tsx
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.75 }} onClick={(e) => e.stopPropagation()}>
            <TextField
              size="small"
              label={translate("padmakara.events.titleEn")}
              value={edit.titleEn}
              onChange={(e) => setEdit((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
              onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
              autoFocus
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Button size="small" variant="text"
                disabled={!edit.titleEn.trim() || translating !== null}
                startIcon={translating === "titleEn" ? <CircularProgress size={14} /> : undefined}
                onClick={() => translateSide("titleEn", "titlePt", "titlePtReviewed", "en-to-pt")}>
                {translate("padmakara.events.translateToPt")}
              </Button>
              {!edit.titleEnReviewed && (
                <>
                  <Chip size="small" color="warning" variant="outlined" label={translate("padmakara.events.aiUnreviewed")} />
                  <Button size="small" variant="text" onClick={() => setEdit((p) => ({ ...p, titleEnReviewed: true }))}>
                    {translate("padmakara.events.markReviewed")}
                  </Button>
                </>
              )}
            </Box>
            <TextField
              size="small"
              label={translate("padmakara.events.titlePt")}
              value={edit.titlePt}
              onChange={(e) => setEdit((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
              onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Button size="small" variant="text"
                disabled={!edit.titlePt.trim() || translating !== null}
                startIcon={translating === "titlePt" ? <CircularProgress size={14} /> : undefined}
                onClick={() => translateSide("titlePt", "titleEn", "titleEnReviewed", "pt-to-en")}>
                {translate("padmakara.events.translateToEn")}
              </Button>
              {!edit.titlePtReviewed && (
                <>
                  <Chip size="small" color="warning" variant="outlined" label={translate("padmakara.events.aiUnreviewed")} />
                  <Button size="small" variant="text" onClick={() => setEdit((p) => ({ ...p, titlePtReviewed: true }))}>
                    {translate("padmakara.events.markReviewed")}
                  </Button>
                </>
              )}
            </Box>
          </Box>
```

Leave the non-editing branch (`<Typography>{session.titleEn}</Typography>`) and the check/edit `IconButton`s unchanged — the check button already calls `handleSaveTitle`.

- [ ] **Step 5: Typecheck** — `sh -c 'cd .../padmakara-api/admin && npx tsc -b'` → no errors.

- [ ] **Step 6: Commit**

```bash
git add padmakara-api/admin/src/components/SessionPreview.tsx
git commit -m "feat(admin): translate session titles EN/PT in-form with review flags"
```

---

## Task 5: i18n (session-title fallback labels)

**Files:**
- Modify: `padmakara-api/admin/src/i18n/en.ts`, `padmakara-api/admin/src/i18n/pt.ts`

The translate/review labels (`translateToPt`, `translateToEn`, `aiUnreviewed`, `markReviewed`, `translateError`) and `titleEn`/`titlePt` already exist under `padmakara.events` from Plan 1 and the base file — `SessionCard` reuses them, so **no new keys are strictly required.** This task only exists to confirm that.

- [ ] **Step 1:** Confirm `padmakara.events.titleEn`, `titlePt`, `translateToPt`, `translateToEn`, `aiUnreviewed`, `markReviewed`, `translateError` all resolve in both `en.ts` and `pt.ts` (Plan 1 added the translate/review ones; `titleEn`/`titlePt` pre-exist). If any is missing, add it mirroring Plan 1. No commit if nothing changed.

---

## Task 6: End-to-end manual verification

- [ ] **Step 1:** With API + admin running and `ANTHROPIC_API_KEY` set, open an existing event in **Edit**, expand a session, click its edit pencil → EN and PT title fields appear.
- [ ] **Step 2:** Type an English session title → **→ Português** fills the PT field with an **AI · unreviewed** chip → click the check to save → reload the event → the PT title persisted (this is the previously-missing session persistence).
- [ ] **Step 3:** **Mark reviewed** clears the chip and persists; editing a field by hand keeps it reviewed.
- [ ] **Step 4:** In the app, switch interface language EN↔PT → the session title shows the matching translation (via the existing `mapSession.name_translations`), confirming no app change was needed.
- [ ] **Step 5:** Create a brand-new event with sessions, set EN+PT session titles, save → both persist (create-flow payload).

---

## Self-Review (completed by plan author)

**Spec coverage (this slice):** session-title EN↔PT translation ✔ (Task 4); per-field + reviewed ✔ (Tasks 1,3,4); session-edit persistence gap fixed ✔ (Task 3); migration `0029` hand-written ✔ (Task 1); admin-only reviewed, app unchanged ✔ (verified Task 6.4). **Deferred:** track titles (Plan 3).

**Placeholder scan:** none — Tasks 2.3 and 3.2 point at literals/handlers the typecheck enumerates, with the exact code to add; every other step carries full code.

**Type consistency:** `onSessionTitleChange(idx, patch: Partial<InferredSession>)` is changed in lockstep across `EventFormProps`, `SessionPreviewProps`, the `SessionCard` wiring, and both screen handlers (Task 3); the four session fields `titlePt`/`titleEnReviewed`/`titlePtReviewed` match across the Drizzle schema (Task 1), Zod (Task 1), `InferredSession` (Task 2), `toInferredSessions` (Task 2), the create payload (Task 3.4), and `SessionCard`'s `edit` object (Task 4).
