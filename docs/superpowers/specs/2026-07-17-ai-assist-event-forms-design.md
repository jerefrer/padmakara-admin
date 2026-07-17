# AI Assist on Both Event Forms — Design

**Date:** 2026-07-17
**Status:** Approved (proceeding to implementation)
**Area:** `padmakara-api` admin UI + backend

## Problem

The event **create** form has an "AI bulk edit" textarea: an admin types a
plain-English instruction and Claude returns per-track suggestions (title +
speaker) that the admin reviews before saving. The event **edit** form has no
such box. Admins editing an existing event cannot use AI to clean up titles or
normalize speakers without deleting and re-creating the event.

We want the edit form to have the same capability, and — per the product
owner — we want to **expand** what the AI can do on **both** forms beyond
track title/speaker to also cover **session titles** and **event fields**.

## Goals

1. Render an AI-instruction textarea on the event **edit** form with the same
   capabilities and settings as the create form.
2. Expand AI capabilities on **both** forms to also edit:
   - Session titles (`titleEn` / `titlePt`)
   - Event fields: `titleEn`, `titlePt`, `description`, `startDate`, `endDate`
3. Expanded operations (session/event edits) fire **only when the instruction
   explicitly asks for them**. The default behavior remains track title/speaker
   cleanup, matching today.
4. Keep the AI **non-destructive**: it never mutates S3 or the DB; the admin
   reviews suggestions and applies them, then saves through the normal flow.

## Non-Goals

- Reordering tracks.
- Splitting or merging sessions or tracks (explicitly dropped).
- Editing relational/structural event fields: teachers, retreat groups, places,
  `status`, `featuredAt`, `eventCode`.
- Any audio-file manipulation.
- A per-form settings UI. "Same customized settings" means both forms use the
  identical model/prompt/roster config — guaranteed by sharing one backend
  service, not by exposing knobs.

## Current State (as of this spec)

### Frontend
- The AI box lives **inside** `admin/src/components/SessionTrackTable.tsx`,
  gated by the `enableAiRename` prop (UI at ~1061–1107, handler `handleApplyAi`
  at ~991–1051). It POSTs `{ instruction, rows }` to
  `/api/admin/upload/rename-tracks` and applies `{ suggestions }` to the
  component's in-memory table state.
- `EventCreate` (`admin/src/resources/events.tsx` ~1567) renders
  `SessionTrackTable` with `enableAiRename`. `EventEdit` (~2076) renders tracks
  through `SessionPreview` instead and has **no** AI box.
- Both forms share `EventFormFields` for the event-level fields.
- Placeholder/labels in the AI box are **hardcoded English** (violates the
  project's localization rule).

### Backend
- Two **byte-for-byte identical** handlers (differ only in route path):
  - `POST /api/admin/upload/rename-tracks` — `src/routes/admin/upload.ts` 146–226
    (used by create; stateless, no event id).
  - `POST /api/admin/events/:id/rename-tracks` — `src/routes/admin/events.ts`
    294–376 (built for edit; ignores `:id`, currently unused by the frontend).
- Both: validate with `renameTracksSchema` (`src/lib/schemas.ts` 317–330), load
  the full teacher roster, call Anthropic `claude-haiku-4-5-20251001`
  (`max_tokens: 4096`, no temperature), strip markdown fences, `JSON.parse`,
  resolve speakers via `resolveSpeaker` / `rosterPromptBlock`
  (`src/services/speaker-resolve.ts`), and return
  `{ suggestions: { rowKey, title?, speaker?, speakerUnmatched? }[] }`.

## Design

### Overview

Approach: **shared component + shared backend service, capabilities expanded**,
delivered in two phases.

- **Phase 1 — Parity + de-dup.** Extract the AI box into a standalone
  `AiAssistPanel`, render it on both forms at today's capability (track
  title/speaker), and collapse the two identical backend handlers into one
  shared service. Ships the literal original request with no capability drift.
- **Phase 2 — Expanded capabilities.** Extend the request/response contract,
  prompt, and apply-logic to session titles and event fields on both forms,
  gated behind explicit instruction intent.

### 1. Frontend: `AiAssistPanel`

New file `admin/src/components/AiAssistPanel.tsx`. A self-contained MUI card:
textarea (multiline), "Apply" button, busy/error state via `useNotify`, all
strings localized via `t()`.

**Props (interface):**
```ts
interface AiAssistPanelProps {
  /** Current event-level fields the AI may edit (Phase 2). */
  event: {
    titleEn?: string;
    titlePt?: string;
    description?: string;
    startDate?: string;
    endDate?: string;
  };
  /** Sessions with a stable rowKey (client key on create, DB id on edit). */
  sessions: Array<{
    rowKey: string;
    titleEn?: string;
    titlePt?: string;
    tracks: Array<{
      rowKey: string;
      originalFilename: string;
      title: string;
      speaker?: string | null;
    }>;
  }>;
  /** Endpoint to call (create → stateless, edit → event-scoped). */
  endpoint: string;
  /** Applies a reviewed suggestion set to the host form's state. */
  onApply: (result: AiAssistResult) => void;
  /** Whether expanded (event/session) edits are enabled. */
  enableStructural?: boolean;
}
```

The panel owns the fetch (via `authFetch`) and the **review UI**; it hands the
reviewed result to the host through `onApply`. It does **not** know how the host
persists — create applies to in-memory table state, edit applies through its
existing update handlers.

`SessionTrackTable`'s embedded AI box is removed; `enableAiRename` is retired in
favor of rendering `AiAssistPanel`. The migration usage of `SessionTrackTable`
(`migrations.tsx`) does not use `enableAiRename`, so it is unaffected.

### 2. Apply model — review then apply (non-destructive)

1. Admin types an instruction, clicks Apply.
2. Panel POSTs the event/session/track context, receives suggestions.
3. Panel shows a compact **old → new diff** for every affected item, grouped by
   Event / Session / Track. Speaker matches flagged `speakerUnmatched` are
   visually marked (as today).
4. Admin confirms. `onApply(result)` fires.
   - **Create:** host writes values into its in-memory form/table state; nothing
     persists until the Create button (unchanged behavior).
   - **Edit:** host writes through the existing update paths
     (`dataProvider.update` for `events` / `sessions` / `tracks`) — the same
     paths a manual field edit already uses. The AI itself still never calls the
     DB; the host does, after review.

This preserves the current "AI never mutates; caller applies" contract and adds
a confirmation gate before anything touches a live event.

### 3. Backend: shared service + expanded contract

**New** `src/services/ai-assist.ts` (exports an `aiAssistEvent` function). It
holds the Anthropic call, prompt
assembly, fence-stripping, JSON parsing, and speaker resolution — everything the
two handlers currently duplicate. Both routes become thin wrappers that parse
the body, call the service, and return its result.

- `POST /api/admin/upload/rename-tracks` (create, no id) → service.
- `POST /api/admin/events/:id/rename-tracks` (edit, has id) → service.

Model, `max_tokens`, roster injection: **unchanged** — identical settings on
both forms by construction.

**Expanded request** (new schema `aiAssistSchema`, superseding
`renameTracksSchema`; the old field shape remains a valid subset so nothing
breaks mid-migration):
```ts
{
  instruction: string,               // 1..2000
  event?: {                          // Phase 2; omitted → no event edits
    titleEn?: string; titlePt?: string;
    description?: string;
    startDate?: string; endDate?: string;
  },
  sessions?: Array<{                 // Phase 2; omitted → no session edits
    rowKey: string;
    titleEn?: string; titlePt?: string;
  }>,
  tracks: Array<{                    // required; today's `rows`
    rowKey: string;
    originalFilename: string;
    title: string;
    speaker?: string | null;
  }>,
}
```

**Expanded response:**
```ts
{
  event?: {                          // only changed fields
    titleEn?: string; titlePt?: string;
    description?: string;
    startDate?: string; endDate?: string;
  },
  sessions: Array<{ rowKey: string; titleEn?: string; titlePt?: string }>,
  tracks:   Array<{ rowKey: string; title?: string; speaker?: string;
                    speakerUnmatched?: true }>,
}
```

Speaker values still pass through `resolveSpeaker`. Dates are returned as-is by
the model; the service validates them as ISO `YYYY-MM-DD` and **drops** any
malformed date suggestion rather than emitting an invalid value.

### 4. Prompt

Extend the system prompt to describe the three entity types and their editable
fields, and to add the explicit-intent rule:

> Only suggest changes to `event` or `session` fields when the instruction
> explicitly asks about the event or sessions. If the instruction is about track
> titles or speakers, return only `tracks` suggestions and leave `event`/
> `sessions` empty. Return only the JSON object, no prose, no fences.

The teacher roster block (`rosterPromptBlock`) is appended unchanged.

Output shape moves from a bare JSON **array** (tracks only) to a JSON **object**
with `event` / `sessions` / `tracks` keys. Fence-stripping and the
"drop malformed" parsing posture are retained.

### 5. Event-field scope

Editable by AI: `titleEn`, `titlePt`, `description`, `startDate`, `endDate`.
Excluded: teachers, retreat groups, places, `status`, `featuredAt`,
`eventCode`. The schema simply does not accept those fields, so the model has no
channel to change them.

### 6. Localization

New locale keys under `aiAssist.*` in both `en.json` and `pt.json` (admin app):
heading, description/placeholder, apply button, applying state, success/error
notifications, the review-diff labels (Event / Session / Track, "unmatched
speaker"). All panel copy uses `t('aiAssist.…') || 'Fallback'`.

## API Contract Change Summary

| | Before | After |
|---|---|---|
| Request | `{ instruction, rows[] }` | `{ instruction, event?, sessions?, tracks[] }` |
| Response | `{ suggestions[] }` (array of track edits) | `{ event?, sessions[], tracks[] }` |
| Endpoints | 2 identical handlers | 2 thin handlers → 1 shared service |

Frontend and backend ship together, so the shape change is coordinated (no
external consumers of these admin endpoints).

## Phasing & Order of Work

**Phase 1 (parity + de-dup, independently shippable):**
1. Backend: extract shared service; both routes delegate. No behavior change.
2. Frontend: create `AiAssistPanel` at track-title/speaker capability; render on
   create (replacing the embedded box) and on edit (new). Edit uses the
   event-scoped endpoint.
3. Localize the panel.
4. Tests green.

**Phase 2 (expanded capabilities):**
5. Backend: expand schema + prompt + service to event/session edits; date
   validation; explicit-intent gating.
6. Frontend: pass event/session context; extend review UI + `onApply` to write
   event/session fields; enable `enableStructural` on both forms.
7. Tests for the expanded paths.

## Testing

Per `padmakara-api/CLAUDE.md` (tests are mandatory):

- **Backend service** `tests/services/ai-assist.test.ts`: mock Anthropic +
  db roster. Cover: track-only instruction returns only track edits; explicit
  event instruction returns event edits; explicit session instruction returns
  session edits; malformed date dropped; markdown fences stripped; speaker
  resolution + `speakerUnmatched`; bad JSON → `AppError`.
- **Backend routes** `tests/routes/admin/*`: both endpoints validate the new
  schema, 400 on invalid body, delegate to the (mocked) service.
- **Frontend** `AiAssistPanel`: renders localized copy; Apply calls the endpoint
  with the built payload; review diff shows only changed fields; `onApply`
  receives the reviewed result; error path notifies. (React Testing Library —
  behavior, not internals, per TS rules.)

## Risks & Mitigations

- **Regression on the working create form.** Mitigated by Phase 1 being a
  behavior-preserving refactor with tests before touching the UI, and by the
  service extraction being a pure move.
- **AI over-reaching into event/session fields.** Mitigated by explicit-intent
  prompt gating, the review-then-apply gate, and a schema that cannot express
  excluded fields.
- **Invalid dates from the model.** Mitigated by ISO validation that drops bad
  values.
- **rowKey identity differs (client key on create, DB id on edit).** The host
  builds rows with the appropriate key and maps suggestions back by it; the
  service treats `rowKey` as an opaque string (unchanged from today).

## Open Questions

None blocking. Roster scoping to the event's own teachers on the edit endpoint
is a possible future refinement; default keeps the full roster for parity.
