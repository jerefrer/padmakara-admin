/**
 * Pure helpers for editing a slide in place inside its rendered iframe.
 */

import type { Slide, Span } from "@slides/types.ts";

/**
 * Editing affordances added on top of the shared renderer's own CSS: the
 * layout rules are untouched, only outlines and the caret colour are added,
 * so the slide reads exactly as it will be burned. 1rem is 1% of the frame
 * height, so the outline scales with the slide.
 */
export const CANVAS_EDIT_CSS = `
[data-line-id]{cursor:pointer}
.text-line{outline:none;caret-color:#fff}
[data-line-id]:hover{outline:0.2rem dashed rgba(255,255,255,0.25);outline-offset:0.5rem}
[data-line-id][data-selected="true"]{outline:0.2rem dashed rgba(255,255,255,0.7);outline-offset:0.5rem}
`;

const ZERO_WIDTH_SPACE = /​/g;

/**
 * The renderer keeps an empty line's box with a zero-width space. After
 * typing in the browser that character is still in the DOM, so it is dropped
 * on the way back into the model, and an emptied line is one empty span.
 */
export function cleanEditedSpans(spans: Span[]): Span[] {
  const cleaned = spans
    .map((s) => ({ ...s, text: s.text.replace(ZERO_WIDTH_SPACE, "") }))
    .filter((s) => s.text.length > 0);
  return cleaned.length > 0 ? cleaned : [{ text: "" }];
}

/** True when `next` differs from `prev` only in the text spans of `lineId`. */
export function onlySpansChanged(prev: Slide, next: Slide, lineId: string | null): boolean {
  if (!lineId) return false;
  const strip = (slide: Slide): string =>
    JSON.stringify({
      ...slide,
      lines: slide.lines.map((l) => (l.id === lineId && l.type === "text" ? { ...l, spans: [] } : l)),
    });
  return strip(prev) === strip(next) && JSON.stringify(prev) !== JSON.stringify(next);
}

/**
 * Whether the canvas may keep its current iframe document for `next`: when the
 * slide is unchanged, or only the line being typed in changed. Reloading the
 * document mid-typing drops the keystrokes that land in the old one, and React
 * may compute the canvas twice for one render (StrictMode), the second time
 * with an unchanged slide.
 */
export function canKeepCanvasDocument(prev: Slide, next: Slide, lineId: string | null): boolean {
  if (prev === next || JSON.stringify(prev) === JSON.stringify(next)) return true;
  return onlySpansChanged(prev, next, lineId);
}
