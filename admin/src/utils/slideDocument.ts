/**
 * Pure, framework-free operations over a `SlideDocument` (add/remove/reorder
 * slides and lines). Kept separate from `SlideEditor.tsx` so the editing
 * logic is unit-testable without mounting any React/MUI machinery, and so
 * the same operations can back both the "existing video" editor (backed by
 * the real API) and the "draft" pre-upload editor (purely local state).
 */

import {
  DEFAULT_FADE_MS,
  DEFAULT_SLIDE_DURATION_MS,
  type ImageLine,
  type Line,
  type Slide,
  type SlideDocument,
  type SpacerLine,
  type TextLine,
} from "@slides/types.ts";

export type SlideSequenceKey = "intro" | "outro";

/** `crypto.randomUUID()` is available in every environment this code runs in
 *  (browsers, Bun, modern Node) — this thin wrapper exists only so tests can
 *  see a single, greppable id source. */
export function newSlideId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Extremely defensive fallback — every real runtime above has randomUUID.
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newTextLine(): TextLine {
  return { id: newSlideId(), type: "text", spans: [{ text: "" }], size: "md" };
}

export function newImageLine(s3Key = ""): ImageLine {
  return { id: newSlideId(), type: "image", s3Key };
}

export function newSpacerLine(): SpacerLine {
  return { id: newSlideId(), type: "spacer" };
}

export function newSlide(lines: Line[] = [newTextLine()]): Slide {
  return { id: newSlideId(), durationMs: DEFAULT_SLIDE_DURATION_MS, fadeMs: DEFAULT_FADE_MS, lines };
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = items.slice();
  const a = next[index];
  const b = next[target];
  next[index] = b;
  next[target] = a;
  return next;
}

export function addSlide(doc: SlideDocument, key: SlideSequenceKey): SlideDocument {
  return { ...doc, [key]: [...doc[key], newSlide()] };
}

export function duplicateSlide(doc: SlideDocument, key: SlideSequenceKey, slideId: string): SlideDocument {
  const idx = doc[key].findIndex((s) => s.id === slideId);
  if (idx < 0) return doc;
  const source = doc[key][idx];
  const copy: Slide = {
    ...source,
    id: newSlideId(),
    lines: source.lines.map((line) => ({ ...line, id: newSlideId() }) as Line),
  };
  const next = doc[key].slice();
  next.splice(idx + 1, 0, copy);
  return { ...doc, [key]: next };
}

export function deleteSlide(doc: SlideDocument, key: SlideSequenceKey, slideId: string): SlideDocument {
  return { ...doc, [key]: doc[key].filter((s) => s.id !== slideId) };
}

export function moveSlide(
  doc: SlideDocument,
  key: SlideSequenceKey,
  slideId: string,
  direction: -1 | 1,
): SlideDocument {
  const idx = doc[key].findIndex((s) => s.id === slideId);
  if (idx < 0) return doc;
  return { ...doc, [key]: moveItem(doc[key], idx, direction) };
}

export function updateSlide(
  doc: SlideDocument,
  key: SlideSequenceKey,
  slideId: string,
  patch: Partial<Pick<Slide, "durationMs" | "fadeMs">>,
): SlideDocument {
  return { ...doc, [key]: doc[key].map((s) => (s.id === slideId ? { ...s, ...patch } : s)) };
}

function updateLines(
  doc: SlideDocument,
  key: SlideSequenceKey,
  slideId: string,
  fn: (lines: Line[]) => Line[],
): SlideDocument {
  return {
    ...doc,
    [key]: doc[key].map((s) => (s.id === slideId ? { ...s, lines: fn(s.lines) } : s)),
  };
}

export function addLine(doc: SlideDocument, key: SlideSequenceKey, slideId: string, line: Line): SlideDocument {
  return updateLines(doc, key, slideId, (lines) => [...lines, line]);
}

export function deleteLine(doc: SlideDocument, key: SlideSequenceKey, slideId: string, lineId: string): SlideDocument {
  return updateLines(doc, key, slideId, (lines) => lines.filter((l) => l.id !== lineId));
}

export function moveLine(
  doc: SlideDocument,
  key: SlideSequenceKey,
  slideId: string,
  lineId: string,
  direction: -1 | 1,
): SlideDocument {
  return updateLines(doc, key, slideId, (lines) => {
    const idx = lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return lines;
    return moveItem(lines, idx, direction);
  });
}

export function replaceLine(
  doc: SlideDocument,
  key: SlideSequenceKey,
  slideId: string,
  lineId: string,
  next: Line,
): SlideDocument {
  return updateLines(doc, key, slideId, (lines) => lines.map((l) => (l.id === lineId ? next : l)));
}
