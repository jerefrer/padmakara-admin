/**
 * Title-slide document model.
 *
 * Slides are stored as a single JSONB document on `event_videos.slides` and are
 * always read and written whole — there is deliberately no relational shape for
 * them. The same document drives the admin preview and the burn container, via
 * the shared renderer in `render.ts`, so what an admin sees is what gets burned.
 *
 * Layout is intentionally NOT configurable: black background, white text, the
 * whole line stack centred vertically and horizontally. The only per-line
 * choices are size, emphasis, and dimming — enough to reproduce the existing
 * Padmakara intro slides and nothing more.
 */

export const SLIDES_VERSION = 1;

/** Relative type sizes, expressed as a percentage of frame height in the CSS. */
export type LineSize = "sm" | "md" | "lg" | "xl";

/** A run of text sharing the same emphasis. Lines are arrays of these so a
 *  single line can mix styles, e.g. "Organizer | **Organizador**". */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TextLine {
  id: string;
  type: "text";
  spans: Span[];
  size: LineSize;
  /** Renders at reduced opacity — matches the date slide in the reference intro. */
  dim?: boolean;
}

export interface ImageLine {
  id: string;
  type: "image";
  /** Object key in the app's storage bucket (S3 today, R2 after migration). */
  s3Key: string;
  alt?: string;
}

/** Blank vertical gap, used to group lines within a slide (see the credits slide). */
export interface SpacerLine {
  id: string;
  type: "spacer";
}

export type Line = TextLine | ImageLine | SpacerLine;

export interface Slide {
  id: string;
  /** How long the slide holds at full opacity, excluding its fades. */
  durationMs: number;
  /** Fade from black in, and back out to black, at each end of the slide. */
  fadeMs: number;
  lines: Line[];
}

export interface SlideDocument {
  version: number;
  intro: Slide[];
  outro: Slide[];
}

export const DEFAULT_SLIDE_DURATION_MS = 4000;
export const DEFAULT_FADE_MS = 800;

/** Total wall-clock time a slide occupies, fades included. */
export function slideTotalMs(slide: Slide): number {
  return slide.fadeMs * 2 + slide.durationMs;
}

/** Total duration of a sequence, used to predict the burned intro length. */
export function sequenceTotalMs(slides: Slide[]): number {
  return slides.reduce((sum, s) => sum + slideTotalMs(s), 0);
}

export function emptySlideDocument(): SlideDocument {
  return { version: SLIDES_VERSION, intro: [], outro: [] };
}

/**
 * True when the document has at least one slide in either sequence. The upload
 * gate uses this: a video may only be uploaded once slides are defined, or the
 * admin has explicitly declared the file already carries burnt-in slides.
 */
export function hasAnySlides(doc: SlideDocument | null | undefined): boolean {
  if (!doc) return false;
  return doc.intro.length > 0 || doc.outro.length > 0;
}

/** Plain text of a line, for accessibility labels and test assertions. */
export function lineText(line: Line): string {
  if (line.type !== "text") return "";
  return line.spans.map((s) => s.text).join("");
}
