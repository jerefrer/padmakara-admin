# Translation UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the admin translation UX — unified EN/PT track titles (no base field), one quiet translate control everywhere, comprehensive "translate all", deterministic session titles, and speaker-resolving AI bulk edit — across both the create (table) and edit (cards) forms.

**Architecture:** Reuses the existing `POST /api/admin/translate` endpoint and `translateFields` helper. The three drifted translate controls (`fieldControls` in events.tsx, `SessionTitleEditor` in SessionTrackTable, the `SessionCard`/track-edit controls in SessionPreview) collapse into one shared `TranslatableField` component + `useFieldTranslate` hook. Tracks get `titleEn`/`titlePt` as their only title fields (base `tracks.title` kept as a hidden DB fallback = `titleEn||titlePt`). Session default titles become deterministic in both languages.

**Tech Stack:** React-admin + MUI + `@mui/icons-material` (installed), Hono + Drizzle + Bun + Vitest (backend), Anthropic Claude Haiku.

## Global Constraints

- **Spec:** `padmakara-api/docs/superpowers/specs/2026-07-17-translation-ux-redesign.md`.
- **Endpoint & schema exist** — no migration. `tracks.title_en/title_pt/title_en_reviewed/title_pt_reviewed` already exist; `ParsedTrack` already has `titleEn?/titlePt?/titleEnReviewed?/titlePtReviewed?`; `TableSession` already has EN/PT + reviewed. Only `TableTrack` needs the four fields added.
- **Admin UI has NO test framework** — admin gates are `sh -c 'cd .../padmakara-api/admin && npx tsc -b'` (must be clean) + manual verification. Pure admin utils (`formatSessionTitle`, `detectTitleLanguage`) are verified by review + manual, not unit tests.
- **Backend tests** via `sh -c 'cd .../padmakara-api && bun test <path>'`. `bun run typecheck` has ~4 pre-existing publications/media errors that are NOT yours.
- **Reviewed semantics:** manual edit of a field → its reviewed=true; translate INTO a field → target reviewed=false; deterministic content (session default titles) → reviewed=true. The app never reads reviewed.
- **`@mui/icons-material` is allowed** (already used in `admin/src/layout/Menu.tsx`).
- **Base `tracks.title` stays** (notNull) — set to `titleEn || titlePt` on every save; never shown in the UI.
- **Conventional Commits.** The api repo auto-appends a `Co-Authored-By` trailer — do not add your own.
- Reuse existing i18n keys where present (`titleEn`, `titlePt`, `translateToPt`, `translateToEn`, `translateAllToPt`, `translateAllToEn`, `aiUnreviewed`, `markReviewed`, `translateNothing`, `translateError`); add new keys only where noted.

---

## File Structure

**New**
- `admin/src/components/TranslatableField.tsx` — the shared quiet EN/PT translate control (component + `useFieldTranslate` hook).
- `tests/routes/admin/rename-tracks-speakers.test.ts` — speaker-resolution tests (or extend the existing `rename-tracks.test.ts`).

**Modified**
- `admin/src/utils/trackParser.ts` — `formatSessionTitle` (EN+PT), `detectTitleLanguage`, deterministic session defaults, title-language pre-fill.
- `admin/src/components/SessionTrackTable.tsx` — `TableTrack` +EN/PT; track cell → EN/PT via `TranslatableField`; `SessionTitleEditor` → `TranslatableField`; "Translate all tracks" button.
- `admin/src/components/SessionPreview.tsx` — track edit form: drop base Title, EN/PT always via `TranslatableField`; `SessionCard` title editor → `TranslatableField`.
- `admin/src/resources/events.tsx` — `fieldControls` → `TranslatableField`; `translateAllMissing` batches everything; `sessionsToTableValue`/`tableValueToSessions` carry TableTrack EN/PT; `handleSave`/`handleTrackUpdate` set `title = titleEn||titlePt`; `toInferredSessions`/`analysisToInferredSessions` title-language pre-fill.
- `src/routes/admin/events.ts` — `rename-tracks`: load teacher roster, prompt + post-match speakers.
- `admin/src/i18n/en.ts`, `pt.ts` — `translateAllTracksToPt`/`translateAllTracksToEn` keys; PT month/period strings live in `trackParser.ts` (not i18n).

---

## Task 1: Deterministic session titles (EN + PT)

**Files:** Modify `admin/src/utils/trackParser.ts`; Modify `admin/src/resources/events.tsx` (`toInferredSessions`, `analysisToInferredSessions`).

**Interfaces:**
- Produces: `formatSessionTitle(date: string | null, timePeriod: string | null, partNumber: number | null, lang: "en" | "pt"): string` (exported from trackParser.ts). Session default titles are generated in both languages, both `reviewed = true`.

- [ ] **Step 1: Add the formatter** — in `trackParser.ts`, add near the top of the module:

```ts
const PERIOD_LABELS: Record<"en" | "pt", Record<string, string>> = {
  en: { morning: "Morning", afternoon: "Afternoon", evening: "Evening" },
  pt: { morning: "Manhã", afternoon: "Tarde", evening: "Noite" },
};
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_PT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

/** Localise a session's date+period default title. `date` may be an ISO date
 *  (YYYY-MM-DD) or an already-formatted string; ISO dates are localised, other
 *  strings are reused verbatim. */
export function formatSessionTitle(
  date: string | null,
  timePeriod: string | null,
  partNumber: number | null,
  lang: "en" | "pt",
): string {
  const period = timePeriod ? PERIOD_LABELS[lang][timePeriod] ?? "" : "";
  let datePart = date ?? "";
  const iso = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const month = parseInt(iso[2]!, 10) - 1;
    const day = parseInt(iso[3]!, 10);
    datePart = lang === "pt"
      ? `${day} de ${MONTHS_PT[month]}`
      : `${MONTHS_EN[month]} ${day}`;
  }
  let title = datePart && period ? `${datePart} – ${period}` : (datePart || period);
  if (!title) return lang === "pt" ? "Sessão" : "Session";
  if (partNumber) title += lang === "pt" ? ` (Parte ${partNumber})` : ` (Part ${partNumber})`;
  return title;
}
```

- [ ] **Step 2: Use it in `inferSessions`** — replace the `let titleEn = ""; if (sample.date ...) { ... }` block (trackParser.ts ~L355-364) and the `titlePt: ""` in the `sessions.push({...})` with:

```ts
    const titleEn = formatSessionTitle(sample.date, sample.timePeriod, sample.partNumber, "en");
    const titlePt = formatSessionTitle(sample.date, sample.timePeriod, sample.partNumber, "pt");
```
and in the pushed object set `titleEn`, `titlePt` (both), keeping `titleEnReviewed: true, titlePtReviewed: true`.

- [ ] **Step 3: DB-loaded + AI sessions** — in `events.tsx` `toInferredSessions`, where it currently does `titlePt: s.titlePt || ""`: if the DB `titlePt` is empty but the session's `titleEn` is a formulaic default, fill it: `titlePt: s.titlePt || (s.titleEn ? formatSessionTitle(s.sessionDate || null, s.timePeriod || null, null, "pt") : "")`. In `analysisToInferredSessions`, where a date+period default would be produced, use `formatSessionTitle(...,"en")` / `("...","pt")` for both instead of blanking PT. (Import `formatSessionTitle` from `../utils/trackParser`.)

- [ ] **Step 4: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api/admin && npx tsc -b'` → clean.

- [ ] **Step 5: Manual check** — a new upload's sessions show localized titles in both fields (e.g. "10 June – Afternoon" / "10 de junho – Tarde"), both marked reviewed (no amber dot).

- [ ] **Step 6: Commit** — `feat(admin): generate session default titles in both EN and PT`.

---

## Task 2: AI bulk-edit resolves speakers to existing teachers

**Files:** Modify `src/routes/admin/events.ts` (`rename-tracks` handler); Create/extend `tests/routes/admin/rename-tracks.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `rename-tracks` returns speaker suggestions resolved to existing teacher abbreviations. Response element gains optional `speakerUnmatched?: true` when a returned speaker matched no teacher.

- [ ] **Step 1: Write the failing test** — add cases to `tests/routes/admin/rename-tracks.test.ts` (it already mocks db + `@anthropic-ai/sdk`). Extend the db mock so `db.query.teachers.findMany` returns a roster, e.g. `[{ abbreviation: "PWR", name: "Pema Wangyal Rinpoche" }, { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" }]`. New cases:
  - Model returns `speaker: "PWR"` → response keeps `"PWR"` (exact code match), no `speakerUnmatched`.
  - Model returns `speaker: "Pema Wangyal Rinpoche"` (a name) → response resolves to `"PWR"`.
  - Model returns `speaker: "pema wangyal"` (partial, different case) → resolves to `"PWR"` (fuzzy/contains match).
  - Model returns `speaker: "Some Unknown Person"` → response keeps the raw string AND sets `speakerUnmatched: true`.

```ts
// add to the existing db mock's query object:
//   teachers: { findMany: vi.fn(() => Promise.resolve([
//     { abbreviation: "PWR", name: "Pema Wangyal Rinpoche" },
//     { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" },
//   ])) }
it("resolves a full teacher name to its abbreviation", async () => {
  mockMessagesCreate.mockResolvedValueOnce(
    makeAnthropicResponse(JSON.stringify([{ rowKey: "1-1", speaker: "Pema Wangyal Rinpoche" }])),
  );
  const token = await adminToken();
  const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ instruction: "Set speaker to Pema", rows: VALID_ROWS }),
  });
  expect(status).toBe(200);
  expect((body as any).suggestions[0]).toMatchObject({ rowKey: "1-1", speaker: "PWR" });
});

it("flags an unmatched speaker", async () => {
  mockMessagesCreate.mockResolvedValueOnce(
    makeAnthropicResponse(JSON.stringify([{ rowKey: "1-1", speaker: "Some Unknown Person" }])),
  );
  const token = await adminToken();
  const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ instruction: "x", rows: VALID_ROWS }),
  });
  expect(status).toBe(200);
  expect((body as any).suggestions[0]).toMatchObject({ speaker: "Some Unknown Person", speakerUnmatched: true });
});
```

- [ ] **Step 2: Run → fail** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun test tests/routes/admin/rename-tracks.test.ts'` → new cases FAIL.

- [ ] **Step 3: Implement** — in `src/routes/admin/events.ts`:
  - Add `import { teachers } from "../../db/schema/users.ts";` (the teachers table — confirm its schema module; grep `export const teachers` under `src/db/schema/`).
  - In the handler, after parsing, load the roster: `const roster = await db.query.teachers.findMany({ columns: { abbreviation: true, name: true } });`
  - Add the roster to the system prompt (append): a line listing `abbreviation — name` for each, plus: *"The `speaker` field must be an existing teacher's abbreviation from this roster. If the instruction names a teacher by code or by full/partial name, map it to the matching abbreviation. Only if there is no plausible match, return the raw string."*
  - After parsing `suggestions`, post-process each `speaker`: resolve against the roster with `resolveSpeaker(raw, roster)`:

```ts
function resolveSpeaker(
  raw: string,
  roster: { abbreviation: string; name: string }[],
): { speaker: string; unmatched?: true } {
  const q = raw.trim().toLowerCase();
  // exact abbreviation
  let m = roster.find((t) => t.abbreviation.toLowerCase() === q);
  if (m) return { speaker: m.abbreviation };
  // exact name
  m = roster.find((t) => t.name.toLowerCase() === q);
  if (m) return { speaker: m.abbreviation };
  // contains / partial (name contains query or query contains name/abbr)
  m = roster.find(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      q.includes(t.name.toLowerCase()) ||
      q.includes(t.abbreviation.toLowerCase()),
  );
  if (m) return { speaker: m.abbreviation };
  return { speaker: raw, unmatched: true };
}
```
  - Apply it where `out.speaker` is set: `if (typeof s.speaker === "string") { const r = resolveSpeaker(s.speaker, roster); out.speaker = r.speaker; if (r.unmatched) out.speakerUnmatched = true; }` and widen the `out` type to include `speakerUnmatched?: true`.

- [ ] **Step 4: Run → pass** — same test command → all pass (incl. the pre-existing rename-tracks cases). Add the `teachers.findMany` mock to the shared db mock so existing tests still boot.

- [ ] **Step 5: Typecheck** — `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && bun run typecheck'` → no new errors.

- [ ] **Step 6: Commit** — `feat(admin): resolve AI bulk-edit speakers to existing teachers`.

---

## Task 3: Shared `TranslatableField` quiet control (+ apply to event title/themes)

**Files:** Create `admin/src/components/TranslatableField.tsx`; Modify `admin/src/resources/events.tsx` (replace `fieldControls`); Modify `admin/src/i18n/en.ts`, `pt.ts` (only if new keys needed).

**Interfaces:**
- Produces:
  - `useFieldTranslate(): { translate(source: string, direction: TranslateDirection): Promise<string | null>, translating: boolean }` — wraps `translateFields` + in-flight state + error notify.
  - `<TranslatableField value onChange reviewed onMarkReviewed onTranslate translatePending label placeholder multiline minRows />` — one text field with a compact **translate icon-button** (fills this field, disabled while `translatePending` or when there's no source) and, when `!reviewed`, a **small amber dot** with a hover "mark reviewed" affordance. `onChange(v)` sets value + reviewed=true; `onTranslate()` runs the translate and sets value + reviewed=false; `onMarkReviewed()` sets reviewed=true.

- [ ] **Step 1: Build the component** — create `admin/src/components/TranslatableField.tsx`. Use `@mui/icons-material/Translate` for the icon and MUI `TextField`, `IconButton`, `Tooltip`, `CircularProgress`, `Box`. Design intent (implement cleanly; use the frontend-design skill for spacing/color): a single field; a small translate `IconButton` adornment (endAdornment or adjacent) that calls `onTranslate`; when `!reviewed`, a subtle amber dot (an 8px `Box` with `bgcolor: "warning.main"`, `borderRadius: "50%"`) sits in the field's end area with a `Tooltip` "AI · unreviewed — click to mark reviewed" whose click calls `onMarkReviewed`. No inline "→ Portuguese" text, no separate chip/button row.

```tsx
import { useState } from "react";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Tooltip from "@mui/material/Tooltip";
import CircularProgress from "@mui/material/CircularProgress";
import TranslateIcon from "@mui/icons-material/Translate";
import { useNotify, useTranslate } from "react-admin";
import { translateFields, type TranslateDirection } from "../utils/translateFields";

export function useFieldTranslate() {
  const notify = useNotify();
  const translate = useTranslate();
  const [translating, setTranslating] = useState(false);
  const run = async (source: string, direction: TranslateDirection): Promise<string | null> => {
    const text = source.trim();
    if (!text) return null;
    setTranslating(true);
    try {
      const out = await translateFields(direction, { v: text });
      return out.v ?? "";
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, { type: "error" });
      return null;
    } finally {
      setTranslating(false);
    }
  };
  return { translate: run, translating };
}

export interface TranslatableFieldProps {
  value: string;
  onChange: (value: string) => void;      // manual edit → caller sets value + reviewed=true
  reviewed: boolean;
  onMarkReviewed: () => void;
  onTranslate: () => void;                // caller runs translate + sets value + reviewed=false
  translatePending: boolean;              // disable translate while any translate in flight
  canTranslate: boolean;                  // false when the source side is empty
  label: string;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
}

export function TranslatableField(props: TranslatableFieldProps) {
  const translate = useTranslate();
  return (
    <TextField
      fullWidth
      size="small"
      label={props.label}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      multiline={props.multiline}
      minRows={props.minRows}
      slotProps={{
        inputLabel: { shrink: true },
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                {!props.reviewed && (
                  <Tooltip title={translate("padmakara.events.aiUnreviewed") + " — " + translate("padmakara.events.markReviewed")}>
                    <Box
                      onClick={props.onMarkReviewed}
                      sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: "warning.main", cursor: "pointer", flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
                <Tooltip title={translate("padmakara.events.translateToPt") /* directional; caller passes correct label via aria */}>
                  <span>
                    <IconButton size="small" edge="end" disabled={!props.canTranslate || props.translatePending} onClick={props.onTranslate}>
                      {props.translatePending ? <CircularProgress size={16} /> : <TranslateIcon fontSize="small" />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
```

- [ ] **Step 2: Replace `fieldControls` usage in `EventFormFields`** — delete the `fieldControls` helper. For each of the six event fields (titleEn/Pt, mainThemesEn/Pt, sessionThemesEn/Pt), replace the `<MuiTextField .../>` + `{fieldControls(...)}` pair with a `<TranslatableField .../>`. Use the shared `const ft = useFieldTranslate();` in `EventFormFields`. For a field (say `titlePt`), wire:
  - `value={form.titlePt}`
  - `onChange={(v) => setForm(p => ({ ...p, titlePt: v, titlePtReviewed: true }))}`
  - `reviewed={form.titlePtReviewed}`
  - `onMarkReviewed={() => setForm(p => ({ ...p, titlePtReviewed: true }))}`
  - `canTranslate={!!String(form.titleEn ?? "").trim()}` (source = the other side)
  - `translatePending={ft.translating}`
  - `onTranslate={async () => { const out = await ft.translate(String(form.titleEn ?? ""), "en-to-pt"); if (out != null) setForm(p => ({ ...p, titlePt: out, titlePtReviewed: false })); }}`
  - `label={translate("padmakara.events.titlePt")}`
  Mirror for the EN side (source = PT side, direction `pt-to-en`) and for the theme fields (add `multiline minRows={syncedRows(...)}`).

- [ ] **Step 3: Typecheck** — admin `npx tsc -b` clean.

- [ ] **Step 4: Manual check** — event title/themes show the field with a translate icon; translating fills the target + shows the amber dot; clicking the dot or editing clears it. Visually cleaner than the old link+chip row.

- [ ] **Step 5: Commit** — `feat(admin): shared quiet TranslatableField control for event title and themes`.

---

## Task 4: Unified track titles (EN/PT everywhere, drop base field) + create-form translation

**Files:** Modify `admin/src/components/SessionTrackTable.tsx`, `admin/src/components/SessionPreview.tsx`, `admin/src/resources/events.tsx`, `admin/src/utils/trackParser.ts`.

**Interfaces:**
- Consumes: `TranslatableField`/`useFieldTranslate` (Task 3).
- Produces: track editors show only Title (EN) + Title (PT); `TableTrack` gains `titleEn/titlePt/titleEnReviewed/titlePtReviewed`; parse pre-fills the detected-language side; `title` saved = `titleEn||titlePt`.

- [ ] **Step 1: Title-language detector** — in `trackParser.ts`, add:

```ts
/** Heuristic: does this title text read as Portuguese? (diacritics + stopwords) */
export function detectTitleLanguage(title: string): "en" | "pt" {
  const t = title.toLowerCase();
  if (/[ãõáéíóúâêôàç]/.test(t)) return "pt";
  if (/\b(de|da|do|das|dos|e|para|com|sessão|oração|orações|ensinamentos?)\b/.test(t)) return "pt";
  return "en";
}
```

- [ ] **Step 2: Pre-fill on parse** — where `inferSessions` builds each `ParsedTrack` (the object with `title: ...`), set `titleEn`/`titlePt` from the parsed title by detected language, leaving the other blank, and mark both reviewed true (human-entered filename title is not AI):
```ts
    const _lang = detectTitleLanguage(title);
    // ...in the ParsedTrack literal:
    titleEn: _lang === "en" ? title : "",
    titlePt: _lang === "pt" ? title : "",
    titleEnReviewed: true,
    titlePtReviewed: true,
```
(keep the existing `title` field too — it stays as the fallback.)

- [ ] **Step 3: `TableTrack` + adapters** — in `SessionTrackTable.tsx` add to `TableTrack`: `titleEn: string; titlePt: string; titleEnReviewed: boolean; titlePtReviewed: boolean;`. In `events.tsx` `sessionsToTableValue`, carry them from the `ParsedTrack` (`titleEn: t.titleEn ?? "", titlePt: t.titlePt ?? "", titleEnReviewed: t.titleEnReviewed ?? true, titlePtReviewed: t.titlePtReviewed ?? true`), and in `tableValueToSessions` read them back from the table track `t` (`titleEn: t.titleEn, titlePt: t.titlePt, titleEnReviewed: t.titleEnReviewed, titlePtReviewed: t.titlePtReviewed`) into the `ParsedTrack`. The `onAddTrack`/any new-`TableTrack` literal gets `titleEn: "", titlePt: "", titleEnReviewed: true, titlePtReviewed: true`.

- [ ] **Step 4: Table track cell → EN/PT** — in `SessionTrackTable.tsx`, replace the single `<TextField label="Title" value={track.title} .../>` in the track cell with two `TranslatableField`s (EN, PT) wired to `onTrackChange(track.key, { titleEn: v, titleEnReviewed: true })` etc., using a local `useFieldTranslate()` (extract a small `TrackTitleEditor` component like `SessionTitleEditor`, so each row's translate state is independent). Keep the filename sub-field below, unchanged. Remove the base title input.

- [ ] **Step 5: Cards track edit → EN/PT always** — in `SessionPreview.tsx` edit form: remove the base `<TextField label="Title" ... helperText="Shown to users in the mobile app" />`, remove the `editValues.languages.length > 1 &&` condition so EN/PT show for ALL tracks, and replace the verbose EN/PT block with two `TranslatableField`s wired to `editValues` (as in Task 3's wiring pattern). `editValues` already has `titleEn/titlePt/titleEnReviewed/titlePtReviewed`.

- [ ] **Step 6: Save sets base title** — in `events.tsx` `EventCreate.handleSave` track-create payload and `EventEdit.handleTrackUpdate` track-update payload, set `title: (track.titleEn || track.titlePt || track.title || "")` (create) / `title: updates.titleEn || updates.titlePt || updates.title` (update) so the notNull base column always reflects a real title. Keep sending `titleEn/titlePt/titleEnReviewed/titlePtReviewed`.

- [ ] **Step 7: Typecheck** — admin `npx tsc -b` clean. Fix any `TableTrack` literal sites the compiler flags (add the four fields).

- [ ] **Step 8: Manual check** — in BOTH create (table) and edit (cards): a track shows Title (EN) + Title (PT) only (no base "Title", no "mobile app" helper); the parsed title sits in the correct-language field; translating fills the other; saving persists both and the app renders by interface language.

- [ ] **Step 9: Commit** — `feat(admin): unify track titles to EN/PT with translation in both forms`.

---

## Task 5: Session titles use the shared control

**Files:** Modify `admin/src/components/SessionTrackTable.tsx` (`SessionTitleEditor`), `admin/src/components/SessionPreview.tsx` (`SessionCard` title editor).

**Interfaces:** Consumes `TranslatableField`.

- [ ] **Step 1: `SessionTitleEditor`** — replace its two TextFields + verbose translate button/chip/mark-reviewed rows with two `TranslatableField`s (EN, PT) wired to `onSessionChange(sIdx, {...})`, using a local `useFieldTranslate()`. Behavior identical (translate EN↔PT, reviewed handling) but via the quiet control.

- [ ] **Step 2: `SessionCard` title editor** — same replacement in the edit-flow session title editor.

- [ ] **Step 3: Typecheck** — admin `npx tsc -b` clean.

- [ ] **Step 4: Manual check** — session titles in both forms use the quiet control; deterministic default titles (Task 1) show no amber dot; a translated title shows the dot until reviewed.

- [ ] **Step 5: Commit** — `feat(admin): session-title editors use the shared quiet control`.

---

## Task 6: Comprehensive "Translate all" + "Translate all tracks"

**Files:** Modify `admin/src/resources/events.tsx` (`translateAllMissing` + buttons), `admin/src/components/SessionTrackTable.tsx` (tracks button), `admin/src/i18n/en.ts`, `pt.ts`.

**Interfaces:** Consumes `translateFields`.

- [ ] **Step 1: i18n keys** — add to both i18n files under `padmakara.events`: `translateAllTracksToPt` ("Translate all tracks → Portuguese" / "Traduzir todas as faixas → Português") and `translateAllToEn` equivalents (`translateAllTracksToEn`).

- [ ] **Step 2: Comprehensive `translateAllMissing`** — rewrite the existing `translateAllMissing(direction)` in `EventFormFields` so it collects EVERY missing target into one request: event title, main themes, session themes (as today), PLUS each session's title and each track's title across `sessions`. Build `items` keyed uniquely — `"event:titlePt"`, `"session:<i>:titlePt"`, `"track:<sIdx>:<key>:titlePt"` — with the source = the other-language sibling, only where the target is empty and the source non-empty. One `translateFields(direction, items)` call. Then distribute: `setForm` for event fields, and call the session/track update paths (`onSessionTitleChange`/the track update callback the form already holds) for each result, marking each filled target unreviewed. If nothing to translate, `notify(translateNothing)`.

- [ ] **Step 3: "Translate all tracks" button** — add a small `[Translate all tracks → PT] [→ EN]` control near the session/track section. It builds `items` for track titles only (across all sessions) and distributes results via the track update path. (In the create table, place it in the table toolbar; in the edit cards, above the session list. A shared handler in `EventFormFields` that both invoke keeps it DRY.)

- [ ] **Step 4: Typecheck** — admin `npx tsc -b` clean.

- [ ] **Step 5: Manual check** — "Translate all → PT" fills every empty PT field (event, themes, session titles, track titles) in one go, each showing the amber dot; "Translate all tracks → PT" fills only track PT titles; already-filled fields are skipped.

- [ ] **Step 6: Commit** — `feat(admin): translate-all covers sessions and tracks; add translate-all-tracks`.

---

## Self-Review (completed by plan author)

**Spec coverage:** 4.A unified track titles ✔ (Task 4); 4.B quiet control ✔ (Task 3 + applied in 4/5); 4.C comprehensive translate-all + tracks button ✔ (Task 6); 4.D deterministic session titles ✔ (Task 1); 4.E speaker matching ✔ (Task 2); 4.F create-form track translation ✔ (Task 4). Base `title` kept as fallback, set on save ✔ (Task 4.6). No migration (columns exist) ✔.

**Placeholder scan:** none — deterministic logic (formatSessionTitle, detectTitleLanguage, resolveSpeaker, TranslatableField) is given as complete code; the visual polish of TranslatableField is intentionally left to frontend-design within the given baseline (a design task, not a gap).

**Type consistency:** `TranslatableField`/`useFieldTranslate` props are defined in Task 3 and consumed identically in Tasks 3/4/5; the four track fields `titleEn/titlePt/titleEnReviewed/titlePtReviewed` are named consistently across `TableTrack` (Task 4.3), `ParsedTrack` (pre-existing), the adapters (4.3), the editors (4.4/4.5), and the save payloads (4.6); `formatSessionTitle` signature matches its call sites (Task 1); `resolveSpeaker` return shape matches its use (Task 2).
