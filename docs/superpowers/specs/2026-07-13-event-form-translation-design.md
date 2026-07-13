# Event Form Translation & Adaptive Track Titles — Design

**Date:** 2026-07-13
**Status:** Approved (design) — ready for implementation plan
**Scope:** `padmakara-api` (backend + admin UI), small change in `padmakara-app`

---

## 1. Context & current state

The admin re-uploads legacy events one-by-one, each with EN/PT content. Today the admin
must type every Portuguese/English field by hand, and one class of track titles does not
adapt to the user's interface language.

**Verified data model (not JSON blobs — paired per-language columns):**

- **Events** (`src/db/schema/retreats.ts`, table `retreats`, exported as `events`):
  `titleEn` (notNull), `titlePt`, `mainThemesEn`, `mainThemesPt`, `sessionThemesEn`,
  `sessionThemesPt`. Note: **"session themes" is an event-level free-text blob**, not
  per-session data.
- **Sessions** (`src/db/schema/sessions.ts`): `titleEn`, `titlePt` (both nullable),
  `description` (single-language), `sessionNumber`, `partNumber`, `sessionDate`, `timePeriod`.
- **Tracks** (`src/db/schema/tracks.ts`): **single** `title` (notNull), `trackNumber`,
  `languages text[]` (default `['en']`), `originalLanguage` (default `'en'`), `isTranslation`,
  `originalTrackId` (self-ref), unique `(sessionId, trackNumber, originalLanguage)`.
  Parallel-language tracks are **separate rows** sharing `sessionId + trackNumber`,
  distinguished by `originalLanguage`. A single file containing multiple languages is **one
  row** whose `languages` array has length > 1.

**Two independent language axes in the app:**

1. **Interface language** (`en`/`pt`, `contexts/LanguageContext.tsx`, `utils/i18n.ts`) — the
   UI chrome; already drives event/session title selection via `name_translations`.
2. **Content language** (`contentLanguage: 'en' | 'en-pt' | 'pt'`) — *which track rows are
   shown*, via `utils/trackFiltering.ts` (`filterTracksByLanguage`). The app never translates
   a track title; it filters which row appears.

**Existing translation infrastructure to build on:**

- `POST /admin/events/:id/translate-themes` (`src/routes/admin/events.ts:285`) — Claude Haiku,
  Buddhist-terminology system prompt, JSON output. **Currently unused by the UI**, requires a
  saved event id, only handles themes, and writes straight to the DB. **This endpoint is
  replaced by the stateless endpoint below.**
- `src/services/glossary.ts` — `GLOSSARY` term list + `glossaryBlock()`.
- `src/services/subtitle-translate.ts` — reference for `messages.parse` + structured output.
- `src/config.ts` — `config.anthropic.apiKey` (`ANTHROPIC_API_KEY`), `ANTHROPIC_TRANSLATE_MODEL`.

**Admin UI (hand-built MUI + `useState`, not react-admin `<SimpleForm>`):**

- `admin/src/resources/events.tsx` — `EventFormData` (~L456), `EMPTY_FORM` (~L476),
  `EventFormFields` (~L556–952): `titleEn` (~L650), `titlePt` (~L661), themes block (~L836–888:
  `mainThemesEn` L840, `mainThemesPt` L852, `sessionThemesEn` L864, `sessionThemesPt` L876).
  `EventCreate` (~L1201) / `EventEdit` (~L2100) both reuse `EventFormFields`; `handleSave`
  creates event → sessions → tracks (~L1428).
- `admin/src/components/SessionTrackTable.tsx` — session title input (`session.titleEn` ~L1018)
  and the track rows (title, `languages`, `originalLanguage`, `isTranslation`).
- `admin/src/components/SessionPreview.tsx:201` — a second session-title edit spot.

**App track rendering:**

- `padmakara-app/services/retreatService.ts` — `mapTrack` (~L181, `title: backend.title`),
  `mapEvent` `name_translations` (~L104), `mapSession` `name_translations` (~L156).
- `padmakara-app/types/index.ts` — `Track` (~L128, `title` L130, `languages` L138).
- `padmakara-app/components/AudioPlayer.tsx:221` and
  `padmakara-app/app/(tabs)/(groups)/retreat/[id].tsx:1526` render the track title.
- `padmakara-app/utils/i18n.ts` — `getTranslatedName(obj, lang)` (~L131) is the existing
  "pick by interface language, fall back" helper pattern.

---

## 2. Goals

1. In the event create/edit form, translate **event title**, **main themes**, and
   **session themes** between EN↔PT without leaving the form (works on unsaved *create* forms).
2. Same per-field translation for **each session's title** (`sessions.titleEn/titlePt`).
3. **Combined multi-language track titles** (one row, `languages.length > 1`) adapt to the
   user's interface language (EN/PT).
4. Every AI-generated translation carries a **`reviewed` (yes/no)** flag — admin QA metadata
   only; it never gates frontend display.

## 3. Non-goals

- **Split per-language track titles are not translated.** A row whose audio is a single
  language keeps its single `title`, which already matches its audio. (Chosen: "Minimal".)
- No language **badge** on track rows (only the minimal model was chosen; split-track titles
  still signal their own audio language, so no badge is required).
- `reviewed` does **not** gate frontend visibility — only event `draft/published` does.
- Not surfacing main/session **themes** in the app (a separate pre-existing gap).
- No new translation provider — Anthropic Claude only.

---

## 4. Feature 1 — In-form translation

### 4.1 Backend: stateless translate endpoint

**New:** `POST /api/admin/translate` (register a new `src/routes/admin/translate.ts` under the
admin router). **Remove** the unused `POST /admin/events/:id/translate-themes`.

**Request**

```jsonc
{
  "direction": "en-to-pt" | "pt-to-en",
  "items": { "<fieldKey>": "<source text>", ... }   // opaque, index-based keys, e.g. "title", "mainThemes", "session:0:title"
}
```

**Response**

```jsonc
{ "translations": { "<fieldKey>": "<translated text>", ... } }
```

**Behaviour**

- Validate with Zod: `direction` ∈ the two values (else 400); `items` non-empty with string
  values (else 400).
- Read `config.anthropic.apiKey`; if missing → 500 `AppError.internal`.
- Model: `claude-haiku-4-5-20251001` (matches the existing themes prompt — cheap/fast for short
  fields). Keep it in one named constant so it is easy to change.
- System prompt: translate Buddhist teaching material from `{from}` → European `{to}`, preserve
  dharma names / Sanskrit / Tibetan terms, preserve structure/formatting, **include
  `glossaryBlock()`**, and instruct: respond with a JSON object mapping each **input key** to
  its translated string, nothing else.
- Parse: strip ``` fences (as the existing endpoint does) → `JSON.parse` → validate with
  `z.record(z.string())`. On parse/validation failure → 500 `AppError.internal`.
- **Stateless: no DB writes, no event id.** This is what makes it usable on unsaved create
  forms and reusable for session/track titles.

### 4.2 Admin UI (`events.tsx` + `SessionTrackTable.tsx`)

Both **per-field** and **global** controls (as chosen):

- **Per-field** — a small `[EN→PT]` / `[PT→EN]` control between each EN/PT input pair
  (event title, main themes, session themes, and each session title). An explicit click
  translates the source side into the target and **overwrites** the target (intent is
  unambiguous because the admin clicked that field's button).
- **Global** — `[Translate all EN→PT]` / `[Translate all PT→EN]` at the top of the form.
  One request carrying every filled source field; fills **only empty** target fields (never
  clobbers in bulk). Session titles may be included in the same request via `session:<idx>:title`
  keys.
- A shared client helper (e.g. `admin/src/utils/translateFields.ts`) calls the endpoint and
  returns the `translations` map; the form's `setForm` / session-change handlers apply results.
- **UX states:** disable the involved buttons + show a spinner while in flight; on error use
  react-admin `useNotify` with an error message; never leave the form stuck in a spinner.

---

## 5. Feature 2 — Interface-adaptive track titles (Minimal)

### 5.1 Schema

Add to `tracks` (nullable; keep `title NOT NULL` as fallback):

- `titleEn text` (`title_en`)
- `titlePt text` (`title_pt`)

### 5.2 Admin (`SessionTrackTable.tsx`)

- When a track row is **multi-language** (`languages.length > 1`), the title cell exposes
  **EN/PT inputs** + a per-field translate button (reusing §4.1).
- Single-language rows keep the one `title` field, unchanged.
- Track objects in form state gain `titleEn`/`titlePt` (+ reviewed flags, §6); the create/update
  write path (`handleSave` → admin track routes) must persist them.

### 5.3 App

- `types/index.ts` `Track`: add `title_translations?: { en?: string; pt?: string }` (mirrors the
  existing `name_translations` convention).
- `retreatService.mapTrack`: build `title_translations` from backend `titleEn`/`titlePt` when
  present.
- **Backend read path:** confirm the app-facing track payload from `GET /api/events/:id`
  includes `titleEn`/`titlePt` (Drizzle returns all columns, but verify the serializer in
  `src/routes/events.ts` passes them through).
- New render helper `getTrackTitle(track, interfaceLang)` = `title_translations?.[interfaceLang]
  || title`. Apply it in `AudioPlayer.tsx:221` and `retreat/[id].tsx:1526`. Uses the
  **interface** language (not `contentLanguage`). Split tracks have no translations → fall back
  to their single title. This is the entire "minimal" behaviour, no branching on track type.

---

## 6. Reviewed state (admin-only QA metadata)

### 6.1 Model — explicit per-side boolean columns (not JSON)

Chosen over a single JSON-per-row for consistency with the codebase's paired-column convention
and to allow a future "events with unreviewed translations" filter.

- **events:** `titleEnReviewed`, `titlePtReviewed`, `mainThemesEnReviewed`,
  `mainThemesPtReviewed`, `sessionThemesEnReviewed`, `sessionThemesPtReviewed`
- **sessions:** `titleEnReviewed`, `titlePtReviewed`
- **tracks:** `titleEnReviewed`, `titlePtReviewed`

All `boolean NOT NULL DEFAULT true` (existing/hand-typed content is treated as needing no
review; existing rows migrate to `true`).

### 6.2 Rules (all client-side, persisted via the normal save)

- Applying a translation to a field → that side's `reviewed = false`.
- Manually editing a field (typing) → that side's `reviewed = true` (a human touched it).
- Explicit **"mark reviewed"** checkbox on a field toggles `reviewed = true` without editing.
- An amber **"AI · unreviewed"** chip shows next to any field whose `reviewed = false`.
- The stateless endpoint stays pure — reviewed flags live in admin form state and are saved
  through the existing event/session/track create/update payloads. The admin create/update
  **routes must persist the new flags**.

### 6.3 App

The app **never reads `reviewed`.** Unreviewed translations render normally; only event
`draft/published` gates visibility.

---

## 7. Schema changes & migrations

Hand-written SQL + `_journal.json` entries, per the api workflow (never `db:push`; use
`ADD COLUMN IF NOT EXISTS`). Highest existing migration is `0027`.

- **`0028_translation_review_flags.sql`** — 6 boolean columns on `retreats`, 2 on `sessions`
  (`... boolean NOT NULL DEFAULT true`).
- **`0029_track_title_translations.sql`** — `tracks`: `title_en text`, `title_pt text`,
  `title_en_reviewed boolean NOT NULL DEFAULT true`, `title_pt_reviewed boolean NOT NULL DEFAULT true`.

Also update the Drizzle schema files (`retreats.ts`, `sessions.ts`, `tracks.ts`) with matching
camelCase columns.

Apply locally with `bun db:migrate`; prod applied via `psql -f` + `drizzle.__drizzle_migrations`
row + service restart (out of scope for this plan).

---

## 8. Data flow

```
Admin form / session / track editor
  └─(unsaved OK)→ POST /api/admin/translate { direction, items } → { translations }
        └─ setForm(target = translation; target.reviewed = false)
  └─ manual edit → field.reviewed = true
  └─ "mark reviewed" → field.reviewed = true
  └─ Save → existing create/update routes persist titleEn/titlePt (+ reviewed flags)

App  GET /api/events/:id → tracks include titleEn/titlePt
  └─ mapTrack → title_translations
  └─ getTrackTitle(track, interfaceLang) = title_translations?.[lang] || title
```

---

## 9. Error handling

- Endpoint: 400 (invalid direction / empty items / non-string values); 500 (missing API key,
  Anthropic failure, unparseable/invalid model output). All via `AppError`.
- UI: `useNotify` error; buttons re-enabled; no partial field corruption (only the requested
  keys are written).

---

## 10. Testing

- **Backend** `tests/routes/admin/translate.test.ts` (mock `@anthropic-ai/sdk`):
  happy path returns keyed translations; invalid `direction` → 400; empty `items` → 400;
  missing `ANTHROPIC_API_KEY` → 500; malformed model output → 500.
- **App**: unit-test `getTrackTitle` (translation present → picks interface lang; absent →
  falls back to `title`).
- **Admin UI**: verify tooling in `admin/`. If a component test runner exists, add a
  React-Testing-Library test that clicking a per-field translate button (fetch mocked) fills the
  target and sets its `reviewed` chip. Otherwise document a manual verification: create-form
  translate, global translate skips filled targets, edit clears the chip, combined-track EN/PT
  inputs appear only when `languages.length > 1`.

---

## 11. Files touched (checklist)

**padmakara-api (backend):**
- `src/routes/admin/translate.ts` (new) + register in admin router
- `src/routes/admin/events.ts` — remove `:id/translate-themes`
- `src/db/schema/retreats.ts`, `sessions.ts`, `tracks.ts` — new columns
- `src/db/migrations/0028_*.sql`, `0029_*.sql` + `meta/_journal.json`
- admin create/update routes for events/sessions/tracks — persist new fields
- `src/routes/events.ts` — verify tracks payload includes `titleEn/titlePt`
- `tests/routes/admin/translate.test.ts` (new)

**padmakara-api/admin (UI):**
- `admin/src/resources/events.tsx` — `EventFormData`, `EMPTY_FORM`, `EventFormFields`
  (per-field + global translate controls, reviewed chips/checkboxes)
- `admin/src/components/SessionTrackTable.tsx` — session-title translate control + reviewed;
  combined-track EN/PT title inputs + translate + reviewed
- `admin/src/utils/translateFields.ts` (new) — endpoint client helper
- `admin/src/i18n/en.ts`, `pt.ts` — labels for translate buttons / reviewed chip

**padmakara-app:**
- `types/index.ts` — `Track.title_translations`
- `services/retreatService.ts` — `mapTrack` builds `title_translations`
- `utils/i18n.ts` (or a track util) — `getTrackTitle` helper
- `components/AudioPlayer.tsx`, `app/(tabs)/(groups)/retreat/[id].tsx` — use helper

---

## 12. Decisions to log in `DECISIONS.md`

- **Track titles = "Minimal"**: only combined multi-language rows get `titleEn/titlePt`; split
  per-language rows keep their single audio-language title. *Why:* single rendering path with a
  fallback; split-track titles already match their audio, so translating them is redundant data
  and would require a language badge.
- **`reviewed` = explicit per-side boolean columns**, default `true`, admin-only. *Why:* matches
  the paired-column convention, queryable for a future admin filter; JSON-per-row rejected for
  inconsistency with the rest of the schema.
- **Stateless `/api/admin/translate`** replaces the id-bound `translate-themes`. *Why:* must work
  on unsaved create forms and be reusable across event/session/track fields.
