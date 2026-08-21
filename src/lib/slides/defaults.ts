/**
 * Default slide templates, generated from event metadata.
 *
 * These reproduce the existing Padmakara intro exactly — the five-slide
 * sequence used on the Tenga Rinpoche recordings (teacher / event type /
 * date / organizer+place / credits) — but sourced from the database instead
 * of being typed by hand into a video editor.
 *
 * The generator is a pure function over a plain metadata object so it can be
 * unit-tested without a database, and so the admin can regenerate a template
 * client-side to preview it before committing.
 *
 * Slides are bilingual (English then Portuguese on the same card), matching
 * the existing archive. A burned-in card is one language per file, so this is
 * a deliberate choice rather than a fallback — see the design doc.
 */

import {
  DEFAULT_FADE_MS,
  DEFAULT_SLIDE_DURATION_MS,
  SLIDES_VERSION,
  type Line,
  type LineSize,
  type Slide,
  type SlideDocument,
  type Span,
  type TextLine,
} from "./types.ts";

/** Everything the templates can draw on. All fields optional — a missing one
 *  simply drops its line rather than rendering an empty or "undefined" card. */
export interface SlideTemplateMetadata {
  /** Teacher display names, in event order. One line each on slide 1. */
  teacherNames: string[];
  eventTypeEn?: string | null;
  eventTypePt?: string | null;
  /** ISO "YYYY-MM-DD". The video's own date wins over the event start date. */
  date?: string | null;
  organizer?: string | null;
  placeName?: string | null;
  placeLocation?: string | null;
  /** Credits block, e.g. "Projeto Audio-Video" / "Padmakara Lusófona". */
  creditLines?: string[];
  /** Rendered verbatim after the © glyph. */
  copyrightHolder?: string | null;
  copyrightYear?: number | null;
  /** Storage key of the logo used on the outro slide. */
  logoS3Key?: string | null;
}

/** Deterministic id factory. The caller injects one so tests get stable ids
 *  and the admin gets real uuids. */
export type IdFactory = () => string;

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

/** "2009-06-21" → "21 June 2009". Returns null for anything unparseable, so a
 *  bad date drops the line instead of rendering "NaN". */
export function formatDateEn(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const month = MONTHS_EN[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** "2009-06-21" → "21 Junho 2009". */
export function formatDatePt(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const month = MONTHS_PT[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

function span(text: string, style?: Omit<Span, "text">): Span {
  return { text, ...style };
}

function textLine(
  newId: IdFactory,
  spans: Span[],
  size: LineSize,
  dim = false,
): TextLine {
  return { id: newId(), type: "text", spans, size, dim };
}

function slide(newId: IdFactory, lines: Line[]): Slide {
  return {
    id: newId(),
    durationMs: DEFAULT_SLIDE_DURATION_MS,
    fadeMs: DEFAULT_FADE_MS,
    lines,
  };
}

/**
 * Build the default 5-slide intro. Slides whose entire content is missing are
 * omitted, so a sparsely-populated event yields a shorter — but still
 * coherent — sequence rather than blank cards.
 */
export function buildDefaultIntro(
  meta: SlideTemplateMetadata,
  newId: IdFactory,
): Slide[] {
  const slides: Slide[] = [];

  // 1 — Teacher(s), the largest type on the sequence.
  if (meta.teacherNames.length > 0) {
    slides.push(
      slide(
        newId,
        meta.teacherNames.map((name) => textLine(newId, [span(name)], "xl")),
      ),
    );
  }

  // 2 — Event type, italic. Bilingual on one line when both names exist and
  //     differ ("Teachings | Ensinamentos").
  const typeEn = meta.eventTypeEn?.trim();
  const typePt = meta.eventTypePt?.trim();
  const typeText = typeEn && typePt && typeEn !== typePt
    ? `${typeEn} | ${typePt}`
    : typeEn || typePt;
  if (typeText) {
    slides.push(slide(newId, [textLine(newId, [span(typeText, { italic: true })], "lg")]));
  }

  // 3 — Date, English above Portuguese, dimmed like the reference.
  if (meta.date) {
    const en = formatDateEn(meta.date);
    const pt = formatDatePt(meta.date);
    const lines: Line[] = [];
    if (en) lines.push(textLine(newId, [span(en)], "md", true));
    if (pt && pt !== en) lines.push(textLine(newId, [span(pt)], "md", true));
    if (lines.length > 0) slides.push(slide(newId, lines));
  }

  // 4 — Organizer and place, each as a small bilingual label over a bold value,
  //     separated by an em-dash rule.
  const organizer = meta.organizer?.trim();
  const place = [meta.placeName?.trim(), meta.placeLocation?.trim()]
    .filter(Boolean)
    .join(", ");
  if (organizer || place) {
    const lines: Line[] = [];
    if (organizer) {
      lines.push(textLine(newId, [span("Organizer | Organizador")], "sm"));
      lines.push(textLine(newId, [span(organizer, { bold: true })], "md"));
    }
    if (organizer && place) {
      lines.push(textLine(newId, [span("—")], "md"));
    }
    if (place) {
      lines.push(textLine(newId, [span("Place | Local")], "sm"));
      lines.push(textLine(newId, [span(place, { bold: true })], "md"));
    }
    slides.push(slide(newId, lines));
  }

  // 5 — Credits and copyright.
  const credits = (meta.creditLines ?? []).map((l) => l.trim()).filter(Boolean);
  const holder = meta.copyrightHolder?.trim();
  if (credits.length > 0 || holder) {
    const lines: Line[] = [];
    if (credits.length > 0) {
      lines.push(
        textLine(
          newId,
          [span("Camera, archival, and editing | Filmagem, arquivo e edição", {
            italic: true,
            bold: true,
          })],
          "sm",
        ),
      );
      for (const credit of credits) {
        lines.push(textLine(newId, [span(credit, { bold: true })], "md"));
      }
    }
    if (holder) {
      if (credits.length > 0) lines.push({ id: newId(), type: "spacer" });
      const year = meta.copyrightYear ?? new Date().getFullYear();
      lines.push(textLine(newId, [span(`© ${holder}, ${year}`)], "sm"));
    }
    slides.push(slide(newId, lines));
  }

  return slides;
}

/**
 * Sentinel image key for assets shipped with the app rather than stored in the
 * object store. Both consumers of the renderer resolve it locally — the admin
 * preview from its `public/images/` directory, the burn container from the
 * assets baked into the image — so the default outro works with no upload and
 * no storage round-trip.
 *
 * Any `resolveImageUrl` implementation must handle the `@builtin/` prefix.
 */
export const BUILTIN_PREFIX = "@builtin/";
export const BUILTIN_LOGO_KEY = `${BUILTIN_PREFIX}padmakara-logo.png`;

export function isBuiltinKey(s3Key: string): boolean {
  return s3Key.startsWith(BUILTIN_PREFIX);
}

/** Filename portion of a builtin key, e.g. "padmakara-logo.png". */
export function builtinFilename(s3Key: string): string {
  return s3Key.slice(BUILTIN_PREFIX.length);
}

/**
 * Build the default outro: the Padmakara logo, centred, alone.
 *
 * Falls back to the bundled logo when the caller supplies no key, so a freshly
 * generated template always has a working outro.
 */
export function buildDefaultOutro(
  meta: SlideTemplateMetadata,
  newId: IdFactory,
): Slide[] {
  const key = meta.logoS3Key?.trim() || BUILTIN_LOGO_KEY;
  return [
    slide(newId, [{ id: newId(), type: "image", s3Key: key, alt: "Padmakara" }]),
  ];
}

export function buildDefaultSlideDocument(
  meta: SlideTemplateMetadata,
  newId: IdFactory,
): SlideDocument {
  return {
    version: SLIDES_VERSION,
    intro: buildDefaultIntro(meta, newId),
    outro: buildDefaultOutro(meta, newId),
  };
}
