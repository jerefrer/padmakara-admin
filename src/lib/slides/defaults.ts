/**
 * Default slide templates, generated from event metadata.
 *
 * The default intro follows the sequence designed by Padmakara's designer:
 * logo + wordmark, speaker, speaker + event title, month/year + place,
 * session number + date, credits. White small-caps serif on black, one
 * language per video: an English video gets English slides, and the
 * Portuguese is meant to arrive as subtitles rather than as a second line.
 *
 * The generator is a pure function over a plain metadata object so it can be
 * unit-tested without a database, and so the admin can regenerate a template
 * client-side to preview it before committing.
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

export type SlideLanguage = "en" | "pt";

export function isSlideLanguage(value: unknown): value is SlideLanguage {
  return value === "en" || value === "pt";
}

/** Which session of the event a video covers, for the "Session 1 of 4" slide. */
export interface SlideSessionInfo {
  /** 1-based position of the session within the event. */
  number: number;
  /** How many sessions the event has. */
  total: number;
  /** ISO "YYYY-MM-DD"; falls back to the metadata date when absent. */
  date?: string | null;
  /** "morning" | "afternoon" | "evening"; any other value is left out. */
  period?: string | null;
}

/** Everything the templates can draw on. All fields optional — a missing one
 *  simply drops its line rather than rendering an empty or "undefined" card. */
export interface SlideTemplateMetadata {
  /** Teacher display names, in event order. */
  teacherNames: string[];
  /** The event's own title (not its type), per language. */
  titleEn?: string | null;
  titlePt?: string | null;
  /** ISO "YYYY-MM-DD". The video's own date wins over the event start date. */
  date?: string | null;
  organizer?: string | null;
  placeName?: string | null;
  placeLocation?: string | null;
  /** Who produced the video; each entry is its own line under "Video Production". */
  creditLines?: string[];
  /** Used for "Video Production" when the event has no credit lines. */
  copyrightHolder?: string | null;
  session?: SlideSessionInfo | null;
  /** Storage key of the logo used on the logo slide and the outro. */
  logoS3Key?: string | null;
}

/** Inputs the default intro could not find. Each one drops (part of) a slide. */
export type MissingSlideInput =
  | "teacher"
  | "title"
  | "date"
  | "place"
  | "session"
  | "organizer"
  | "production";

/** Deterministic id factory. The caller injects one so tests get stable ids
 *  and the admin gets real uuids. */
export type IdFactory = () => string;

const MONTHS: Record<SlideLanguage, string[]> = {
  en: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
  pt: [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ],
};

interface Labels {
  organizedBy: string;
  production: string;
  session: (n: number, total: number) => string;
  periods: Record<string, string>;
}

const LABELS: Record<SlideLanguage, Labels> = {
  en: {
    organizedBy: "Event organized by",
    production: "Video Production",
    session: (n, total) => `Session ${n} of ${total}`,
    periods: { morning: "morning", afternoon: "afternoon", evening: "evening" },
  },
  pt: {
    organizedBy: "Evento organizado por",
    production: "Produção de vídeo",
    session: (n, total) => `Sessão ${n} de ${total}`,
    periods: { morning: "manhã", afternoon: "tarde", evening: "noite" },
  },
};

function monthName(lang: SlideLanguage, month: number): string | null {
  return MONTHS[lang][month - 1] ?? null;
}

function parseIso(iso: string): { year: string; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return { year: m[1] ?? "", month: Number(m[2]), day: Number(m[3]) };
}

/** "2026-10-10" → "October 2026" / "Outubro 2026". Null for anything
 *  unparseable, so a bad date drops the line instead of rendering "NaN". */
export function formatMonthYear(iso: string, lang: SlideLanguage): string | null {
  const d = parseIso(iso);
  const month = d ? monthName(lang, d.month) : null;
  if (!d || !month) return null;
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.year}`;
}

/** "2026-10-10" → "10 October 2026" / "10 de outubro de 2026". */
export function formatLongDate(iso: string, lang: SlideLanguage): string | null {
  const d = parseIso(iso);
  const month = d ? monthName(lang, d.month) : null;
  if (!d || !month) return null;
  return lang === "pt" ? `${d.day} de ${month} de ${d.year}` : `${d.day} ${month} ${d.year}`;
}

function span(text: string, style?: Omit<Span, "text">): Span {
  return { text, ...style };
}

/** A white small-caps line, the default look of the intro. */
function capsLine(newId: IdFactory, text: string, size: LineSize): TextLine {
  return { id: newId(), type: "text", spans: [span(text)], size, smallCaps: true };
}

/** A small italic label or secondary line, kept in lower case. */
function italicLine(newId: IdFactory, text: string, size: LineSize): TextLine {
  return { id: newId(), type: "text", spans: [span(text, { italic: true })], size };
}

function spacer(newId: IdFactory): Line {
  return { id: newId(), type: "spacer" };
}

function slide(newId: IdFactory, lines: Line[], durationMs = DEFAULT_SLIDE_DURATION_MS): Slide {
  return { id: newId(), durationMs, fadeMs: DEFAULT_FADE_MS, lines };
}

/** The logo slide is a beat, not a statement: the designer found the gap
 *  between the logo and the speaker's name too long. */
export const LOGO_SLIDE_DURATION_MS = 2500;

function resolveTitle(meta: SlideTemplateMetadata, lang: SlideLanguage): string {
  return ((lang === "pt" ? meta.titlePt : meta.titleEn) ?? "").trim();
}

function resolvePlace(meta: SlideTemplateMetadata): string {
  return [meta.placeName?.trim(), meta.placeLocation?.trim()].filter(Boolean).join(", ");
}

function resolveProduction(meta: SlideTemplateMetadata): string[] {
  const credits = (meta.creditLines ?? []).map((l) => l.trim()).filter(Boolean);
  if (credits.length > 0) return credits;
  const holder = meta.copyrightHolder?.trim();
  return holder ? [holder] : [];
}

function resolveTeachers(meta: SlideTemplateMetadata): string[] {
  return meta.teacherNames.map((n) => n.trim()).filter(Boolean);
}

/** Which of the inputs the default intro draws on are absent. */
export function missingSlideInputs(
  meta: SlideTemplateMetadata,
  lang: SlideLanguage = "en",
): MissingSlideInput[] {
  const missing: MissingSlideInput[] = [];
  if (resolveTeachers(meta).length === 0) missing.push("teacher");
  if (!resolveTitle(meta, lang)) missing.push("title");
  if (!meta.date || !formatMonthYear(meta.date, lang)) missing.push("date");
  if (!resolvePlace(meta)) missing.push("place");
  if (!meta.session) missing.push("session");
  if (!meta.organizer?.trim()) missing.push("organizer");
  if (resolveProduction(meta).length === 0) missing.push("production");
  return missing;
}

/**
 * Sentinel image key for assets shipped with the app rather than stored in the
 * object store. Both consumers of the renderer resolve it locally — the admin
 * preview from its `public/images/` directory, the burn container from the
 * assets baked into the image — so the default slides work with no upload and
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
 * Build the default intro in one language. Slides whose data is missing are
 * omitted, so a sparsely-populated event yields a shorter — but still
 * coherent — sequence rather than blank cards. The logo slide needs no data.
 */
export function buildDefaultIntro(
  meta: SlideTemplateMetadata,
  newId: IdFactory,
  lang: SlideLanguage = "en",
): Slide[] {
  const other: SlideLanguage = lang === "en" ? "pt" : "en";
  // The other language is built only to read its text; its ids are discarded.
  let scratch = 0;
  const otherSlides = new Map(
    buildKeyedIntro(meta, () => `scratch-${scratch++}`, other).map((k) => [k.key, k.slide]),
  );
  return buildKeyedIntro(meta, newId, lang).map(({ key, slide: built }) => {
    const subtitle = key === "logo" ? null : subtitleLines(built, otherSlides.get(key));
    return subtitle ? { ...built, subtitles: { [other]: subtitle } } : built;
  });
}

type IntroSlideKey = "logo" | "teacher" | "title" | "date" | "session" | "credits";

/** The visible text of a slide, one entry per text line. */
function slideTexts(s: Slide): string[] {
  return s.lines.flatMap((l) => (l.type === "text" ? [l.spans.map((sp) => sp.text).join("")] : []));
}

/** The other language's text for a slide, or null when it would only repeat
 *  what is already on screen (a speaker's name reads the same in both). */
function subtitleLines(built: Slide, counterpart: Slide | undefined): string[] | null {
  if (!counterpart) return null;
  const texts = slideTexts(counterpart);
  if (texts.length === 0) return null;
  const burned = slideTexts(built);
  const identical = texts.length === burned.length && texts.every((t, i) => t === burned[i]);
  return identical ? null : texts;
}

function buildKeyedIntro(
  meta: SlideTemplateMetadata,
  newId: IdFactory,
  lang: SlideLanguage,
): { key: IntroSlideKey; slide: Slide }[] {
  const labels = LABELS[lang];
  const slides: { key: IntroSlideKey; slide: Slide }[] = [];
  const add = (key: IntroSlideKey, s: Slide): void => {
    slides.push({ key, slide: s });
  };
  const teachers = resolveTeachers(meta);

  // 1 — Logo, then the wordmark beneath it.
  add("logo", 
    slide(
      newId,
      [
        { id: newId(), type: "image", s3Key: meta.logoS3Key?.trim() || BUILTIN_LOGO_KEY, alt: "Padmakara" },
        capsLine(newId, "Padmakara", "lg"),
      ],
      LOGO_SLIDE_DURATION_MS,
    ),
  );

  // 2 — The speaker alone, centred.
  if (teachers.length > 0) {
    add("teacher", slide(newId, teachers.map((name) => capsLine(newId, name, "xl"))));
  }

  // 3 — Speaker small at the top, the event title centred. The layout has no
  //     positioning, so spacers above and below approximate the reference.
  const title = resolveTitle(meta, lang);
  if (title) {
    const lines: Line[] = teachers.map((name) => capsLine(newId, name, "sm"));
    if (teachers.length > 0) lines.push(spacer(newId), spacer(newId));
    lines.push(capsLine(newId, title, "xl"));
    if (teachers.length > 0) {
      lines.push(spacer(newId), spacer(newId));
      // Balances the speaker lines above so the title stays vertically centred.
      for (let i = 0; i < teachers.length; i++) lines.push(spacer(newId));
    }
    add("title", slide(newId, lines));
  }

  // 4 — Month and year, the place in italics beneath.
  const monthYear = meta.date ? formatMonthYear(meta.date, lang) : null;
  const place = resolvePlace(meta);
  if (monthYear || place) {
    const lines: Line[] = [];
    if (monthYear) lines.push(capsLine(newId, monthYear, "lg"));
    if (place) lines.push(italicLine(newId, place, "md"));
    add("date", slide(newId, lines));
  }

  // 5 — Session number, with the session's date and period in italics.
  if (meta.session) {
    const lines: Line[] = [capsLine(newId, labels.session(meta.session.number, meta.session.total), "lg")];
    const sessionDate = meta.session.date ?? meta.date;
    const longDate = sessionDate ? formatLongDate(sessionDate, lang) : null;
    const period = meta.session.period ? labels.periods[meta.session.period] : undefined;
    const detail = [longDate, period].filter(Boolean).join(", ");
    if (detail) lines.push(italicLine(newId, detail, "md"));
    add("session", slide(newId, lines));
  }

  // 6 — Credits: organizer, then the video production.
  const organizer = meta.organizer?.trim();
  const production = resolveProduction(meta);
  if (organizer || production.length > 0) {
    const lines: Line[] = [];
    if (organizer) {
      lines.push(italicLine(newId, labels.organizedBy, "sm"));
      lines.push(capsLine(newId, organizer, "md"));
    }
    if (organizer && production.length > 0) lines.push(spacer(newId));
    if (production.length > 0) {
      lines.push(italicLine(newId, labels.production, "sm"));
      for (const name of production) lines.push(capsLine(newId, name, "md"));
    }
    add("credits", slide(newId, lines));
  }

  return slides;
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
  lang: SlideLanguage = "en",
): SlideDocument {
  return {
    version: SLIDES_VERSION,
    intro: buildDefaultIntro(meta, newId, lang),
    outro: buildDefaultOutro(meta, newId),
  };
}
