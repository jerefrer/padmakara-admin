# Translation UX Redesign — Design

**Date:** 2026-07-17
**Status:** Approved (design) — ready for implementation plan
**Scope:** `padmakara-api` admin UI + backend; small `padmakara-app` follow-through
**Supersedes UI decisions in:** `2026-07-13-event-form-translation-design.md` (the "Minimal" track-title model is replaced by a unified model below)

## 1. Context — what shipped and what's wrong

The event-form translation feature is live in prod. Real use surfaced these problems (user feedback, with screenshots):

1. **Tracks show THREE title fields** — base `Title` + `Title (English)` + `Title (Portuguese)` — because translations were bolted on top of the pre-existing single `title`. The base field is redundant and confusing; its helper text "Shown to users in the mobile app" is wrong (titles show on every platform, and once EN/PT exist the base isn't shown at all).
2. **The translation UI is cluttered/ugly** — scattered "→ Portuguese / → English" text links, plus a bulky "AI · unreviewed" chip + "Mark reviewed" button on every field.
3. **"Translate all" ignores tracks** (and sessions) — it only fills the three event-level fields.
4. **Session default titles require AI translation** — a session titled "10 June – Afternoon" is generated in EN only (`titlePt=""`), so the PT side is left blank and flagged for AI translation, even though it's purely formulaic.
5. **AI bulk-edit doesn't resolve speakers** — "Set speakers for all tracks on PWR" should map to the existing teacher with code PWR (or match a full name), fuzzy-matching an existing teacher before ever setting an unmatched string.
6. **Track titles can't be translated in the CREATE form** — only in edit.

## 2. Goals

- Make **track titles work exactly like event & session titles**: one field per interface language, no base field in the UI.
- One **consistent, quiet** translation control across event title, main themes, session themes, session titles, and track titles — in **both** the create (table) and edit (cards) forms.
- **"Translate all → PT/EN"** fills every missing target (event + themes + sessions + tracks); plus a scoped **"Translate all tracks → PT/EN"**.
- Session default titles generated in **both** languages deterministically (no AI, no unreviewed state).
- AI bulk-edit **resolves speaker references to existing teachers**.
- Track translation available in the **create** form too.

## 3. Non-goals

- Not merging the two editor components (`SessionPreview` cards / `SessionTrackTable` table) into one — they keep their structures; only the translation model + controls become identical. *(User decision.)*
- Not changing the audio-language model — audio language stays in the `languages` multi-select and the TIB/POR badges, fully separate from titles.
- Not re-doing the app rendering — `getTrackTitle`/`title_translations` already render track titles by interface language across all surfaces.

---

## 4. Design

### 4.A — Unified track title model

**UI:** a track has exactly **Title (EN)** and **Title (PT)**, identical to event/session titles. The base `Title` field and its "Shown to users…" helper are **removed** from both editors.

- **`tracks.title` (DB, notNull) stays as a back-compat fallback**, not shown in the UI. On every create/update it is set to `titleEn || titlePt` (whichever is present) so the app's existing `getTrackTitle(t, lang) = title_translations?.[lang] || title` keeps working for legacy rows and for a language not yet translated.
- **Filename pre-fill by detected title-language:** when tracks are parsed from an upload, the extracted title is placed into `titleEn` **or** `titlePt` based on the **detected language of the title text** (not the audio language). Detection: the create form's existing **AI analysis** classifies each title's language and fills the correct field; on the plain parse path (no AI), a lightweight heuristic (Portuguese diacritics `ç/ã/õ/á/…` + common PT stopwords) decides, defaulting ambiguous titles to the field matching the track's primary non-English `originalLanguage`, else EN. The other field is left blank for translation.
- Admin models: `ParsedTrack` already has `titleEn?/titlePt?/titleEnReviewed?/titlePtReviewed?`. **`TableTrack`** (`SessionTrackTable`) gains the same four. The base `title` remains on both models (kept in sync = `titleEn || titlePt`) for the save payload's `title`.

### 4.B — One consistent, quiet translation control

Applies to every EN/PT pair (event title, main themes, session themes, session titles, track titles), in both forms.

```
  English                                    Português
┌────────────────────────────┐  ⇄  ┌────────────────────────────┐
│ Initial Prayers            │ ──▶ │ Orações iniciais         · │   · = amber dot: AI-filled, unreviewed
└────────────────────────────┘     └────────────────────────────┘
```

- **Per-field translate:** a single compact **icon button** (`@mui/icons-material` `Translate`/`SwapHoriz`, now confirmed available) placed between/adjacent to the pair. It fills the empty side from the filled side; if both are filled, it's directional (translate this side → the other). Replaces the "→ Portuguese / → English" text links. A `CircularProgress size={14}` replaces the icon while in flight.
- **Reviewed state, quieted:** an AI-generated-and-unreviewed field shows a **small amber dot** (and/or a subtle amber left-border), not a chip + button. Hovering/focusing the dot reveals a tiny "mark reviewed" affordance; **editing the field** clears it (already the behavior). Manual edit → reviewed; translate-into → unreviewed (unchanged semantics).
- This is a **visual redesign** — implement with the frontend-design skill for spacing/typography; keep it theme-consistent with the existing MUI admin.

Components touched: `EventFormFields.fieldControls` (events.tsx), `SessionTitleEditor` (SessionTrackTable), `SessionCard` title editor + track edit form (SessionPreview), and the track title cell (SessionTrackTable + SessionPreview).

### 4.C — Comprehensive "Translate all" + tracks-only button

- **"Translate all → PT" / "→ EN"** (top of the form) collects **every** missing target across the whole event — event title, main themes, session themes, each session title, each track title — into **one** `/api/admin/translate` request (keyed uniquely, e.g. `event:title`, `session:<idx>:title`, `track:<key>:title`), then distributes the results and marks each filled target unreviewed. Fills only empty targets.
- **"Translate all tracks → PT" / "→ EN"** near the track list does the same but scoped to track titles only.
- Because the endpoint takes an opaque key→text map and (post the earlier guard) returns only requested keys, batching many items in one call is safe and efficient.

### 4.D — Deterministic session default titles (no AI)

Session titles that are pure date+period are generated in **both** languages by a shared formatter, `formatSessionTitle(date, timePeriod, partNumber, lang)`:

- Period: `morning→Morning/Manhã`, `afternoon→Afternoon/Tarde`, `evening→Evening/Noite`.
- Month names localized when the date carries a month name; otherwise the date string is reused verbatim (language-neutral).
- `(Part N)` → `(Parte N)` in PT.

Applied at all three session-default sites: `inferSessions` (`trackParser.ts:355-364`, currently sets `titlePt=""`), `toInferredSessions` (DB load), and any create-time session construction. These titles are **deterministic → both reviewed=true**, so no amber dot and never sent to Claude. (A human-entered or content-specific session title is unaffected and can still be translated normally.)

### 4.E — Smarter AI bulk-edit speaker matching

Enhance `POST /admin/events/:id/rename-tracks` (events.ts:292):

- **Prompt:** include the full existing-teacher roster (abbreviation + full name) and instruct the model that any speaker reference — a code like `PWR`, or a full/partial name — must resolve to an **existing** teacher's abbreviation; it must fuzzy-match hard against the roster and only fall back to a raw string when there is genuinely no plausible match (and say so).
- **Post-processing (server):** validate each returned `speaker` against the roster: exact code match → keep; else case-insensitive name/abbreviation/fuzzy match → substitute the matched code; else keep the raw value but flag it as unmatched in the response so the UI can surface it. Never silently create a mismatched speaker string when a close existing match exists.
- The roster is already loadable (teachers are a resource); pass abbreviation+name.

### 4.F — Track translation in the create form

`SessionTrackTable`'s track rows get the same EN/PT title fields + per-field translate control as the edit form, driven by `TableTrack.titleEn/titlePt/reviewed` (4.A) and `onTrackChange` patches. The "Translate all tracks" button (4.C) lives here too.

---

## 5. Data flow (unchanged endpoints)

```
Parse upload → title → detect title-language → titleEn OR titlePt (other blank)
Edit in table/cards → titleEn/titlePt/reviewed patched in local model
Save → create/update tracks with { title: titleEn||titlePt, titleEn, titlePt, *Reviewed }
App → GET /events/:id spreads track row → mapTrack → title_translations → getTrackTitle(t, uiLang)
Translate (per-field / all / all-tracks) → POST /api/admin/translate { direction, items } → distribute
Bulk edit → POST /admin/events/:id/rename-tracks { instruction, rows, teachers } → resolved speakers
```

## 6. Files touched (checklist)

**padmakara-api/admin/src:**
- `components/SessionTrackTable.tsx` — `TableTrack` +EN/PT/reviewed; track cell EN/PT title + translate; `SessionTitleEditor` → shared quiet control; "Translate all tracks" button.
- `components/SessionPreview.tsx` — track edit form: drop base title, EN/PT + quiet control; `SessionCard` title editor → shared control.
- `resources/events.tsx` — `sessionsToTableValue`/`tableValueToSessions` carry TableTrack EN/PT; `fieldControls`/`translateAllMissing` → quiet control + comprehensive batch; `handleSave`/`handleTrackUpdate` set `title = titleEn||titlePt`; `toInferredSessions`/`analysisToInferredSessions` deterministic PT session titles + title-language pre-fill.
- `utils/trackParser.ts` — `inferSessions` deterministic EN+PT session titles (new `formatSessionTitle`); title-language detection helper; `TableTrack`/`ParsedTrack` alignment.
- A shared **`TranslatableField`** (or `useFieldTranslate`) primitive so the control is defined once and reused by events/sessions/tracks in both forms (DRY — the control currently exists 3×).
- `i18n/en.ts`, `pt.ts` — any new labels; PT month/period strings.

**padmakara-api/src:**
- `routes/admin/events.ts` — `rename-tracks` prompt + speaker post-matching; pass teacher roster.
- (No new migration — `tracks.title_en/title_pt/*_reviewed` already exist.)

**padmakara-app:** none expected (rendering already unified via `getTrackTitle`); verify combined + single-language tracks still render correctly.

## 7. Testing

- Backend: extend `rename-tracks` tests for speaker resolution (exact code, name match, fuzzy match, no-match flagged) with a mocked roster + Anthropic. `translate` endpoint tests unchanged.
- Unit: `formatSessionTitle` (EN/PT for morning/afternoon/evening, part number, month names) and the title-language detector (PT diacritics/stopwords vs EN, ambiguous default).
- Admin UI: no test framework — manual verification per the checklist.
- App: existing `getTrackTitle` tests still pass; spot-check a single-language track (only one side filled) falls back correctly.

## 8. Decisions to log in `DECISIONS.md`

- **Track titles = unified EN/PT** (reverses the 2026-07-13 "Minimal" model). *Why:* three fields were confusing; consistency with event/session titles; audio language already shown by badges. Base `title` retained as hidden fallback.
- **Deterministic session titles** in both languages, never AI-translated. *Why:* formulaic; AI translation was wasteful and left an unreviewed state on correct-by-construction text.
- **One shared `TranslatableField` control.** *Why:* the translate control existed in 3 places with drift; DRY + consistent redesign.
