/**
 * Serialisation between `Span[]` (the shared slide model's rich-text run
 * list — see `@slides/types.ts`) and the `contentEditable` DOM used to edit
 * it in the admin. Deliberately not a rich-text editor library — the model
 * supports exactly three boolean marks (bold/italic/underline), so a real
 * editor dependency would be solving a problem this feature doesn't have.
 */

import type { Span } from "@slides/types.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Span[] → the HTML seeded into a contentEditable line editor. Mirrors the
 *  shared renderer's own span markup (bold/italic/underline nesting) so what
 *  the admin edits looks like what will be burned, just editable in place. */
export function spansToEditableHtml(spans: Span[]): string {
  return spans
    .map((span) => {
      let html = escapeHtml(span.text).replace(/\n/g, "<br>");
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.underline) html = `<u>${html}</u>`;
      return html;
    })
    .join("");
}

const BOLD_WEIGHT_THRESHOLD = 600;

interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function marksFromElement(el: HTMLElement, inherited: Marks): Marks {
  const tag = el.tagName.toLowerCase();
  const weight = el.style.fontWeight;
  const numericWeight = weight ? Number(weight) : NaN;
  const decoration = `${el.style.textDecorationLine} ${el.style.textDecoration}`;
  return {
    bold:
      inherited.bold ||
      tag === "b" ||
      tag === "strong" ||
      weight === "bold" ||
      (!Number.isNaN(numericWeight) && numericWeight >= BOLD_WEIGHT_THRESHOLD),
    italic: inherited.italic || tag === "i" || tag === "em" || el.style.fontStyle === "italic",
    underline: inherited.underline || tag === "u" || decoration.includes("underline"),
  };
}

/** Walk a contentEditable DOM subtree (after execCommand/typing/paste) and
 *  serialise it back into `Span[]`, merging adjacent runs that share the
 *  same formatting so trivial DOM fragmentation doesn't fan out into a
 *  noisier span list than the admin actually produced. */
export function domToSpans(root: HTMLElement): Span[] {
  const raw: Span[] = [];

  const visit = (node: ChildNode, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text.length > 0) {
        raw.push({
          text,
          ...(marks.bold && { bold: true }),
          ...(marks.italic && { italic: true }),
          ...(marks.underline && { underline: true }),
        });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName.toLowerCase() === "br") {
      raw.push({ text: "\n" });
      return;
    }
    const next = marksFromElement(el, marks);
    for (const child of Array.from(el.childNodes)) visit(child, next);
  };

  for (const child of Array.from(root.childNodes)) {
    visit(child, { bold: false, italic: false, underline: false });
  }

  const merged: Span[] = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && !!last.bold === !!span.bold && !!last.italic === !!span.italic && !!last.underline === !!span.underline) {
      last.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Plain-text length across all spans — used for placeholder detection. */
export function spansTextLength(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + s.text.length, 0);
}
