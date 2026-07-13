# Adaptive Combined-Track Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **combined multi-language track titles** (one track row whose `languages` has more than one entry) adapt to the user's interface language (EN/PT) in the app, editable EN/PT in the admin with translate buttons + a `reviewed` flag. Split per-language tracks keep their single audio-language title (the "Minimal" model).

**Architecture:** Adds nullable `title_en`/`title_pt` (+ two `*_reviewed` booleans) to the `tracks` table. The app gains `Track.title_translations` (built by `mapTrack`, mirroring `name_translations`) and a `getTrackTitle(track, lang)` helper that returns the interface-language title or falls back to the single `title` — so split tracks (no translations) are unaffected. The admin's track-edit form shows EN/PT title fields **only when the track is multi-language**, reusing Plan 1's `/api/admin/translate`. The app-facing `GET /api/events/:id` already spreads the full track row, so `title_en`/`title_pt` flow through with no backend read-path change.

**Tech Stack:** Hono + Drizzle + Bun, React-admin + MUI, React Native/Expo + Jest (app), Anthropic Claude Haiku, Zod v4.

## Global Constraints

- **Spec:** `padmakara-api/docs/superpowers/specs/2026-07-13-event-form-translation-design.md`.
- **Depends on Plan 1** (the `/api/admin/translate` endpoint + `translateFields` helper). Plan 2 is independent of this plan; order 1 → 2 → 3.
- **This is Plan 3 of 3.**
- **Minimal model:** only tracks with `languages.length > 1` get EN/PT titles in the admin. The app renders by interface language with fallback to the single `title`; no branching on track type, and **no new language badge** (the retreat screen already renders per-track language badges).
- **Only the normal new/edit form** (`SessionPreview` track rows). Do not touch the bulk-import / `SessionTrackTable` path.
- **Migrations only, never `db:push`.** Hand-write SQL, `ADD COLUMN IF NOT EXISTS`, append `meta/_journal.json`. This plan uses migration `0030` (Plan 1 → `0028`, Plan 2 → `0029`).
- **`reviewed` is admin-only** (default `true`); the app never reads it.
- Backend tests via `sh -c 'cd .../padmakara-api && bun test <path>'`. App tests via `sh -c 'cd .../padmakara-app && npx jest <path>'`. Admin typecheck via `sh -c 'cd .../padmakara-api/admin && npx tsc -b'`. Admin UI has no test framework — verify manually.
- **Conventional Commits.**

---

## File Structure

**New**
- `padmakara-api/src/db/migrations/0030_track_title_translations.sql`
- `padmakara-app/utils/getTrackTitle.test.ts`

**Modified**
- `padmakara-api/src/db/schema/tracks.ts` — `title_en`, `title_pt`, 2 reviewed booleans.
- `padmakara-api/src/db/migrations/meta/_journal.json` — journal entry for `0030`.
- `padmakara-api/src/lib/schemas.ts` — new fields on `createTrackSchema` and `updateTrackSchema`.
- `padmakara-app/types/index.ts` — `Track.title_translations`.
- `padmakara-app/services/retreatService.ts` — `mapTrack` builds `title_translations`.
- `padmakara-app/utils/i18n.ts` — `getTrackTitle` helper.
- `padmakara-app/components/AudioPlayer.tsx` — use the helper.
- `padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx` — use the helper.
- `padmakara-api/admin/src/utils/trackParser.ts` — `ParsedTrack` gains title EN/PT + reviewed.
- `padmakara-api/admin/src/resources/events.tsx` — `toInferredSessions`, `EventEdit.handleTrackUpdate`, `EventCreate.handleSave` track payload.
- `padmakara-api/admin/src/components/SessionPreview.tsx` — track edit-form EN/PT titles + translate + reviewed.

---

## Task 1: Track title-translation columns (DB + schema + validation)

**Files:**
- Create: `padmakara-api/src/db/migrations/0030_track_title_translations.sql`
- Modify: `padmakara-api/src/db/schema/tracks.ts`, `meta/_journal.json`, `padmakara-api/src/lib/schemas.ts`

**Interfaces:**
- Produces: `tracks.title_en` (text, nullable), `tracks.title_pt` (text, nullable), `tracks.title_en_reviewed`, `tracks.title_pt_reviewed` (`NOT NULL DEFAULT true`) — Drizzle `titleEn`/`titlePt`/`titleEnReviewed`/`titlePtReviewed`; accepted by `createTrackSchema`/`updateTrackSchema`.

- [ ] **Step 1: Migration SQL** — create `0030_track_title_translations.sql`:

```sql
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_en" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_pt" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
```

- [ ] **Step 2: Journal entry** — in `meta/_journal.json`, copy the last entry, `idx` = previous + 1 (`30`), `tag` = `"0030_track_title_translations"`, `when` = current epoch-ms.

- [ ] **Step 3: Drizzle columns** — in `tracks.ts` (`boolean` and `text` are already imported), after `title: text("title").notNull(),` add:

```ts
    titleEn: text("title_en"),
    titlePt: text("title_pt"),
    titleEnReviewed: boolean("title_en_reviewed").notNull().default(true),
    titlePtReviewed: boolean("title_pt_reviewed").notNull().default(true),
```

- [ ] **Step 4: Zod — `createTrackSchema`** — after `title: z.string().min(1).max(200),` add:

```ts
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
```

- [ ] **Step 5: Zod — `updateTrackSchema`** — this schema is a **separate** `z.object({...}).partial()` (not derived from create). Inside its object, after `title: z.string().min(1).max(200),` add:

```ts
  titleEn: z.string().max(200).nullable(),
  titlePt: z.string().max(200).nullable(),
  titleEnReviewed: z.boolean(),
  titlePtReviewed: z.boolean(),
```

(The trailing `.partial()` makes them optional; the track PUT already strips `undefined` before `.set`, so only sent fields update.)

- [ ] **Step 6: Apply** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun db:migrate'` → applies cleanly.

- [ ] **Step 7: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'` → no errors.

- [ ] **Step 8: Commit**

```bash
git add padmakara-api/src/db/migrations/0030_track_title_translations.sql padmakara-api/src/db/migrations/meta/_journal.json padmakara-api/src/db/schema/tracks.ts padmakara-api/src/lib/schemas.ts
git commit -m "feat(db): add track title-translation + review columns"
```

---

## Task 2: App — `Track.title_translations`, `mapTrack`, and `getTrackTitle` (TDD)

**Files:**
- Modify: `padmakara-app/types/index.ts` — `Track`
- Modify: `padmakara-app/utils/i18n.ts` — add `getTrackTitle`
- Modify: `padmakara-app/services/retreatService.ts` — `mapTrack`
- Create: `padmakara-app/utils/getTrackTitle.test.ts`

**Interfaces:**
- Produces: `Track.title_translations?: { en?: string; pt?: string }`; `getTrackTitle(track, lang: Language): string`; `mapTrack` populates `title_translations` from backend `titleEn`/`titlePt`.

- [ ] **Step 1: Write the failing test** — create `padmakara-app/utils/getTrackTitle.test.ts`:

```ts
import { getTrackTitle } from './i18n';

describe('getTrackTitle()', () => {
  it('returns the interface-language translation when present', () => {
    const track = { title: 'base', title_translations: { en: 'Hello', pt: 'Olá' } };
    expect(getTrackTitle(track, 'en')).toBe('Hello');
    expect(getTrackTitle(track, 'pt')).toBe('Olá');
  });

  it('falls back to title when no translation for the language', () => {
    expect(getTrackTitle({ title: 'base', title_translations: { en: 'Hello' } }, 'pt')).toBe('base');
  });

  it('falls back to title when title_translations is absent (split track)', () => {
    expect(getTrackTitle({ title: 'base' }, 'en')).toBe('base');
  });

  it('ignores empty / whitespace-only translations', () => {
    expect(getTrackTitle({ title: 'base', title_translations: { pt: '   ' } }, 'pt')).toBe('base');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && npx jest utils/getTrackTitle.test.ts'`
Expected: FAIL — `getTrackTitle` is not exported yet.

- [ ] **Step 3: Add the helper** — in `padmakara-app/utils/i18n.ts`, next to `getTranslatedName`, add:

```ts
/**
 * Resolve a track's title in the given interface language.
 * Combined multi-language tracks carry `title_translations`; split tracks
 * don't, so this falls back to the single `title`.
 */
export function getTrackTitle(
  track: { title: string; title_translations?: { en?: string; pt?: string } },
  lang: Language,
): string {
  return track.title_translations?.[lang]?.trim() || track.title;
}
```

- [ ] **Step 4: Run the test to confirm it passes** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && npx jest utils/getTrackTitle.test.ts'`
Expected: PASS.

- [ ] **Step 5: Add the type** — in `padmakara-app/types/index.ts`, inside `Track`, after `title: string;` add:

```ts
  title_translations?: { en?: string; pt?: string }; // combined multi-language tracks
```

- [ ] **Step 6: Populate in `mapTrack`** — in `services/retreatService.ts` `mapTrack`, inside the returned object after `title: backend.title || '',` add:

```ts
    title_translations: {
      ...(backend.titleEn || backend.title_en ? { en: backend.titleEn || backend.title_en } : {}),
      ...(backend.titlePt || backend.title_pt ? { pt: backend.titlePt || backend.title_pt } : {}),
    },
```

- [ ] **Step 7: Typecheck the app** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && npx tsc --noEmit'`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add padmakara-app/utils/i18n.ts padmakara-app/utils/getTrackTitle.test.ts padmakara-app/types/index.ts padmakara-app/services/retreatService.ts
git commit -m "feat(app): add getTrackTitle + title_translations for combined tracks"
```

---

## Task 3: App — render track titles by interface language

**Files:**
- Modify: `padmakara-app/components/AudioPlayer.tsx` (~L221)
- Modify: `padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx` (~L1526)

**Interfaces:**
- Consumes: `getTrackTitle` (Task 2), `useLanguage().language`.

- [ ] **Step 1: AudioPlayer** — ensure `getTrackTitle` and the language hook are imported:

```tsx
import { getTrackTitle } from '@/utils/i18n';
import { useLanguage } from '@/contexts/LanguageContext';
```

Inside the component, ensure `const { language } = useLanguage();` is available (add it if not already destructured). Then replace `{currentTrack.title}` (~L221) with:

```tsx
        {getTrackTitle(currentTrack, language)}
```

- [ ] **Step 2: Retreat screen** — in `app/(tabs)/(groups)/retreat/[id].tsx`, ensure `getTrackTitle` is imported from `@/utils/i18n` and that `language` is destructured from the existing `useLanguage()` call (the screen already uses `useLanguage` for `contentLanguage`; add `language` to the destructure if missing). Replace `{track.title}` (~L1526) with:

```tsx
                    {getTrackTitle(track, language)}
```

- [ ] **Step 3: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app && npx tsc --noEmit'`
Expected: no errors.

- [ ] **Step 4: Manual check** — run the app; for an event with a combined multi-language track that has EN+PT titles set, toggle the interface language EN↔PT and confirm the track title text changes; confirm a split (single-language) track's title is unchanged by the toggle.

- [ ] **Step 5: Commit**

```bash
git add "padmakara-app/components/AudioPlayer.tsx" "padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx"
git commit -m "feat(app): render combined-track titles in the interface language"
```

---

## Task 4: Admin — edit combined-track titles EN/PT with translate + reviewed

**Files:**
- Modify: `padmakara-api/admin/src/utils/trackParser.ts` — `ParsedTrack`
- Modify: `padmakara-api/admin/src/resources/events.tsx` — `toInferredSessions` (~L1642), `EventEdit.handleTrackUpdate` (~L1767), `EventCreate.handleSave` track payload (~L1381)
- Modify: `padmakara-api/admin/src/components/SessionPreview.tsx` — track edit-form (`editValues` ~L664, the `if (editing)` form ~L784)

**Interfaces:**
- Consumes: `translateFields` + `TranslateDirection` (Plan 1); track columns (Task 1); i18n keys from Plan 1.
- Produces: `ParsedTrack` gains `titleEn?`, `titlePt?`, `titleEnReviewed?`, `titlePtReviewed?`; combined tracks (`languages.length > 1`) show EN/PT title inputs + translate + reviewed in the edit form; these persist via `onTrackUpdate` (edit) and the create payload.

- [ ] **Step 1: Extend `ParsedTrack`** — in `trackParser.ts`, inside `ParsedTrack`, after `title: string;` add:

```ts
  titleEn?: string;
  titlePt?: string;
  titleEnReviewed?: boolean;
  titlePtReviewed?: boolean;
```

- [ ] **Step 2: Populate in `toInferredSessions`** — in `events.tsx`, in the track map inside `toInferredSessions`, after `title: t.title,` add:

```ts
      titleEn: t.titleEn ?? "",
      titlePt: t.titlePt ?? "",
      titleEnReviewed: t.titleEnReviewed ?? true,
      titlePtReviewed: t.titlePtReviewed ?? true,
```

- [ ] **Step 3: `EventEdit.handleTrackUpdate` — forward the new fields** — in the `dataProvider.update("tracks", { … data: { … } })` call, add to `data`:

```tsx
            titleEn: updates.titleEn,
            titlePt: updates.titlePt,
            titleEnReviewed: updates.titleEnReviewed,
            titlePtReviewed: updates.titlePtReviewed,
```

and in the local-state merge that follows (the `setSessions(...map...)` block), add:

```tsx
                    titleEn: updates.titleEn ?? track.titleEn,
                    titlePt: updates.titlePt ?? track.titlePt,
                    titleEnReviewed: updates.titleEnReviewed ?? track.titleEnReviewed,
                    titlePtReviewed: updates.titlePtReviewed ?? track.titlePtReviewed,
```

(Note the last line reads `track.titlePtReviewed`.)

- [ ] **Step 4: `EventCreate.handleSave` — send the new fields on create** — in the `dataProvider.create("tracks", { data: { … } })` call, add:

```tsx
              titleEn: track.titleEn || null,
              titlePt: track.titlePt || null,
              titleEnReviewed: track.titleEnReviewed ?? true,
              titlePtReviewed: track.titlePtReviewed ?? true,
```

- [ ] **Step 5: SessionPreview imports** — ensure present (some added by Plan 2):

```tsx
import { Chip, CircularProgress } from "@mui/material";
import { useNotify } from "react-admin";
import { translateFields, type TranslateDirection } from "../utils/translateFields";
```

- [ ] **Step 6: Track edit-form state** — in the track row component, extend `editValues` (~L664) to carry the EN/PT titles + reviewed, and add translate state + `notify`:

```tsx
  const notify = useNotify();
  const [translatingTitle, setTranslatingTitle] = useState<string | null>(null);
```

Add to the `useState({ … })` initializer for `editValues`, after `title: track.title || "",`:

```tsx
    titleEn: track.titleEn ?? "",
    titlePt: track.titlePt ?? "",
    titleEnReviewed: track.titleEnReviewed ?? true,
    titlePtReviewed: track.titlePtReviewed ?? true,
```

Add the translate handler in the same component:

```tsx
  const translateTitleSide = async (
    source: "titleEn" | "titlePt",
    target: "titleEn" | "titlePt",
    targetReviewed: "titleEnReviewed" | "titlePtReviewed",
    direction: TranslateDirection,
  ) => {
    const text = (editValues[source] || "").trim();
    if (!text) return;
    setTranslatingTitle(source);
    try {
      const out = await translateFields(direction, { [target]: text });
      setEditValues((prev) => ({ ...prev, [target]: out[target] ?? "", [targetReviewed]: false }));
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslatingTitle(null);
    }
  };
```

- [ ] **Step 7: Render EN/PT title fields for combined tracks** — in the `if (editing)` form, immediately **after** the existing single `Title` `<TextField>` (the one bound to `editValues.title`, ~L784–794), add a conditional block shown only for multi-language tracks:

```tsx
            {editValues.languages.length > 1 && (
              <>
                <TextField
                  size="small"
                  label={translate("padmakara.events.titleEn")}
                  value={editValues.titleEn}
                  onChange={(e) => setEditValues({ ...editValues, titleEn: e.target.value, titleEnReviewed: true })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Button size="small" variant="text"
                    disabled={!editValues.titleEn.trim() || translatingTitle !== null}
                    startIcon={translatingTitle === "titleEn" ? <CircularProgress size={14} /> : undefined}
                    onClick={() => translateTitleSide("titleEn", "titlePt", "titlePtReviewed", "en-to-pt")}>
                    {translate("padmakara.events.translateToPt")}
                  </Button>
                  {!editValues.titleEnReviewed && (
                    <>
                      <Chip size="small" color="warning" variant="outlined" label={translate("padmakara.events.aiUnreviewed")} />
                      <Button size="small" variant="text" onClick={() => setEditValues({ ...editValues, titleEnReviewed: true })}>
                        {translate("padmakara.events.markReviewed")}
                      </Button>
                    </>
                  )}
                </Box>
                <TextField
                  size="small"
                  label={translate("padmakara.events.titlePt")}
                  value={editValues.titlePt}
                  onChange={(e) => setEditValues({ ...editValues, titlePt: e.target.value, titlePtReviewed: true })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Button size="small" variant="text"
                    disabled={!editValues.titlePt.trim() || translatingTitle !== null}
                    startIcon={translatingTitle === "titlePt" ? <CircularProgress size={14} /> : undefined}
                    onClick={() => translateTitleSide("titlePt", "titleEn", "titleEnReviewed", "pt-to-en")}>
                    {translate("padmakara.events.translateToEn")}
                  </Button>
                  {!editValues.titlePtReviewed && (
                    <>
                      <Chip size="small" color="warning" variant="outlined" label={translate("padmakara.events.aiUnreviewed")} />
                      <Button size="small" variant="text" onClick={() => setEditValues({ ...editValues, titlePtReviewed: true })}>
                        {translate("padmakara.events.markReviewed")}
                      </Button>
                    </>
                  )}
                </Box>
              </>
            )}
```

The existing `handleSave` already spreads `...editValues` into `onTrackUpdate`, so the four new fields flow through automatically (Steps 3/4 handle the create + edit persistence). `translate` is already in scope in this component (used by other labels); if not, add `const translate = useTranslate();`.

- [ ] **Step 8: Typecheck** — `sh -c 'cd .../padmakara-api/admin && npx tsc -b'` → no errors.

- [ ] **Step 9: Commit**

```bash
git add padmakara-api/admin/src/utils/trackParser.ts padmakara-api/admin/src/resources/events.tsx padmakara-api/admin/src/components/SessionPreview.tsx
git commit -m "feat(admin): edit combined-track titles EN/PT with translate + review"
```

---

## Task 5: End-to-end manual verification

- [ ] **Step 1:** In the admin, open an event, edit a **multi-language** track (its `languages` has 2+ entries) → the edit form shows EN and PT title fields; a single-language track shows only the one Title field.
- [ ] **Step 2:** Enter an English title → **→ Português** fills PT with an **AI · unreviewed** chip → save → reopen → EN/PT persisted.
- [ ] **Step 3:** In the app, open that event, and toggle interface language EN↔PT → the combined track's title switches between the two; the split track's title does not change.
- [ ] **Step 4:** Confirm an unreviewed combined-track title still renders in the app (reviewed is admin-only).

---

## Self-Review (completed by plan author)

**Spec coverage (this slice):** combined-track `title_en`/`title_pt` columns ✔ (Task 1); Minimal model — only `languages.length > 1` gets EN/PT, split tracks fall back to `title` ✔ (Tasks 2,4); app renders by interface language via `getTrackTitle` with fallback ✔ (Tasks 2,3); no new badge ✔ (retreat screen already has one); backend read path unchanged (row spread) ✔; track `reviewed` admin-only ✔ (Tasks 1,4); migration `0030` hand-written ✔ (Task 1).

**Placeholder scan:** none — every step carries full code; Task 2 is real TDD (test → fail → implement → pass).

**Type consistency:** `getTrackTitle(track, lang)` signature matches its test and both call sites (Tasks 2,3); `title_translations: { en?; pt? }` matches between `Track` (Task 2.5), `mapTrack` (Task 2.6), and the helper (Task 2.3); the four track fields `titleEn`/`titlePt`/`titleEnReviewed`/`titlePtReviewed` match across Drizzle (Task 1), Zod create+update (Task 1), `ParsedTrack` (Task 4.1), `toInferredSessions` (Task 4.2), `handleTrackUpdate` (Task 4.3), the create payload (Task 4.4), and `editValues` (Task 4.6).
