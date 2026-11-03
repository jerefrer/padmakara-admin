/**
 * Copy a slide document from one video to another.
 *
 * Everything the admin edited is kept exactly as is, including the slide that
 * depends on which session the video covers ("Session 2 of 4 — 11 October
 * 2026, morning"): it is cloned like every other slide but flagged
 * `needsReview`, so the editor asks the admin to check the session number and
 * date. That slide is found by its `role`, set by the generator. Documents
 * saved before roles existed carry none, so they are copied as they are and
 * the caller tells the admin to check the session slide.
 */

import type { IdFactory } from "./defaults.ts";
import type { Line, Slide, SlideDocument } from "./types.ts";

export type SessionSlideOutcome =
  /** The source's session slide was copied and flagged for review. */
  | "flagged"
  /** The source has no session slide to find (legacy document or deleted by hand). */
  | "unknown";

export interface CopiedSlides {
  slides: SlideDocument;
  sessionSlide: SessionSlideOutcome;
}

function cloneSlide(slide: Slide, newId: IdFactory): Slide {
  const lines: Line[] = slide.lines.map((l) => ({ ...structuredClone(l), id: newId() }));
  return { ...structuredClone(slide), id: newId(), lines };
}

/** @param source the document being copied, as saved */
export function copySlidesForSession(source: SlideDocument, newId: IdFactory): CopiedSlides {
  let outcome: SessionSlideOutcome = "unknown";

  const intro: Slide[] = source.intro.map((slide) => {
    const copy = cloneSlide(slide, newId);
    if (slide.role === "session") {
      outcome = "flagged";
      copy.needsReview = true;
    }
    return copy;
  });

  return {
    slides: {
      version: source.version,
      intro,
      outro: source.outro.map((s) => cloneSlide(s, newId)),
    },
    sessionSlide: outcome,
  };
}

/** Which language a document's session slide is written in ("Sessão…" is Portuguese). */
export function detectSessionSlideLanguage(doc: SlideDocument): "en" | "pt" | null {
  const slide = doc.intro.find((s) => s.role === "session");
  const first = slide?.lines.find((l) => l.type === "text");
  if (!first || first.type !== "text") return null;
  const text = first.spans.map((s) => s.text).join("");
  if (/^sess[aã]o\b/i.test(text)) return "pt";
  if (/^session\b/i.test(text)) return "en";
  return null;
}
