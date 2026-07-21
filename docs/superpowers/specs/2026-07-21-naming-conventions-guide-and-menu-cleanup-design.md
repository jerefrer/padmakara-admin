# Naming-conventions guide at the drop zone + menu cleanup

**Date:** 2026-07-21
**Status:** Approved (all decisions confirmed by user), autonomous execution.

## Goal

Remove deprecated/misplaced links from the admin menu, and surface the
naming-conventions guide where it is actually needed — at the event-creation
(and event-edit) audio drop zone — as a themed in-app modal that can also be
downloaded as a pristine PDF.

## Decisions (user-confirmed)

1. **Form:** Modal dialog launched from a button at the drop zone (keeps the
   admin on the create page while referencing the rules).
2. **In-app render:** `react-markdown` + `remark-gfm`, styled to the admin
   theme. Single source of truth with the PDF.
3. **Scope:** Button appears on **both** the EventCreate and EventEdit drop
   zones (reusable component).
4. **PDF strategy:** Keep the existing server-side `pdfmake` generator — it
   produces a pristine, selectable, one-click-download file, a better shareable
   artifact for volunteers who name the files. Two stable renderers read one
   `.md`; content edits propagate to both automatically. Nothing except the
   (removed) menu item references `/naming-conventions.pdf`.
5. **Visual polish:** Autonomously review the generated PDF (render to PNG via
   poppler `pdftoppm`) and iterate on the `pdfmake` styles until it looks good.

## Changes

### Menu cleanup — `admin/src/layout/Menu.tsx`
- Remove `/migrations` and `/imports` items (routes not registered in
  `App.tsx` — dead links).
- Remove the whole **Documentation** section (SectionLabel + the
  naming-conventions download `MenuItem`) and its preceding divider.
- Prune newly-unused imports: `SyncAltIcon`, `UploadFileIcon`,
  `DescriptionIcon`, `MenuItem`, `ListItemIcon`.
- Remove the four menu-label i18n keys (`migrations`, `legacyImports`,
  `namingConventions`, `documentation`) from `en.ts` / `pt.ts`.

**Out of scope (flagged, not touched):** the larger legacy `migrations: { … }`
i18n blocks and any orphaned Migration/Import screen components. Dead code
behind the removed links; deleting them is a separate cleanup.

### Content pipeline — `src/scripts/generate-naming-conventions-pdf.ts`
- Also copy raw `docs/NAMING-CONVENTIONS.md` → `admin/public/naming-conventions.md`
  (a committed, regenerated build artifact beside the PDF). The modal fetches
  `/naming-conventions.md` at runtime.

### In-app guide — `admin/src/components/`
- **`NamingConventionsDialog.tsx`** — MUI `Dialog` (`maxWidth="md"`, `fullWidth`,
  `scroll="paper"`). Title bar: "Naming conventions" + Download-PDF button
  (`<a href="/naming-conventions.pdf" download>`) + close icon. Body fetches the
  `.md` once on open, renders via react-markdown + remark-gfm with MUI/theme
  element mapping (h1–h2 burgundy `#9b1b1b`, GFM tables → MUI `Table`, fenced
  code → `#f5f3f0` block, inline code burgundy, blockquote callout). Loading
  spinner + error fallback linking to the PDF.
- **`NamingConventionsButton.tsx`** — button that owns dialog open/close state;
  dropped at both call sites.

### Placement — `admin/src/resources/events.tsx`
- **EventCreate**: inside the drop-zone `Paper`, below `<TrackAnalysisDropZone>`
  (shown on the `!hasFolder` screen).
- **EventEdit**: adjacent to its `TrackDropZone`.

### Dependencies & i18n
- Add `react-markdown` + `remark-gfm` to `admin/package.json`.
- Add `padmakara.namingConventions.*` keys (title, button, downloadPdf, close,
  loadError) to `en.ts` + `pt.ts`.

## Testing / verification
- `bun run typecheck` (api) and admin `tsc` clean.
- Regenerate PDF + `.md`; verify both artifacts present.
- Visual review of the PDF (pdftoppm → PNG) and the modal render.
