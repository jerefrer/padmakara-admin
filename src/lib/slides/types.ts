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
  /** Lowercase letters render as small capitals (`font-variant: small-caps`),
   *  the house style of the Padmakara intro. Capitals keep their full height. */
  smallCaps?: boolean;
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

/**
 * Built-in video clips shipped with the app (the burn container image and the
 * admin's `public/images/`), keyed by the id a clip slide stores. A clip is
 * played as-is: its length is fixed by the file, so it is recorded here and
 * not in the slide. Add the file to both places when adding an entry.
 */
export const BUILTIN_CLIPS = {
  "padmakara-logo-intro": { filename: "padmakara-logo-intro.mp4", durationMs: 8000 },
} as const;

export type BuiltinClipId = keyof typeof BUILTIN_CLIPS;

export function isBuiltinClipId(value: unknown): value is BuiltinClipId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_CLIPS, value);
}

/**
 * What a generated slide is. Set by the default generator so later code (copying
 * slides between videos) can find a slide without guessing from its text.
 * Absent on slides added by hand and on documents saved before roles existed.
 */
export const SLIDE_ROLES = ["logo", "speaker", "title", "date-place", "session", "credits"] as const;
export type SlideRole = (typeof SLIDE_ROLES)[number];

export interface Slide {
  id: string;
  /** See SlideRole. Purely informational; the renderer ignores it. */
  role?: SlideRole;
  /**
   * Absent on an ordinary text/image slide (every document saved before clips
   * existed). `"clip"` marks a built-in video clip played as-is: `clip` names
   * it, `lines` is empty, `durationMs` mirrors the clip's length and `fadeMs`
   * is 0. The clip's own length (BUILTIN_CLIPS) wins in all timing maths.
   */
  kind?: "clip";
  clip?: BuiltinClipId;
  /** How long the slide holds at full opacity, excluding its fades. */
  durationMs: number;
  /** Fade from black in, and back out to black, at each end of the slide. */
  fadeMs: number;
  lines: Line[];
  /**
   * Set when the slide was copied from another video and depends on this
   * video's own data (the session slide): the editor asks the admin to check
   * it and clears the flag on the first edit or when marked as reviewed.
   */
  needsReview?: boolean;
  /**
   * Subtitle text shown over this slide when subtitles are on, one string per
   * cue line, keyed by subtitle language. Slides are burned in the video's own
   * language, so this normally holds the other language only. Optional:
   * documents saved before it existed stay valid.
   */
  subtitles?: SlideSubtitles;
}

export interface SlideSubtitles {
  en?: string[];
  pt?: string[];
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
  if (isClipSlide(slide)) return BUILTIN_CLIPS[slide.clip as BuiltinClipId].durationMs;
  return slide.fadeMs * 2 + slide.durationMs;
}

/** Total duration of a sequence, used to predict the burned intro length. */
export function sequenceTotalMs(slides: Slide[]): number {
  return slides.reduce((sum, s) => sum + slideTotalMs(s), 0);
}

/** A clip slide for a built-in clip; the document stays plain JSON. */
export function makeClipSlide(id: string, clip: BuiltinClipId): Slide {
  return { id, kind: "clip", clip, durationMs: BUILTIN_CLIPS[clip].durationMs, fadeMs: 0, lines: [] };
}

export function isClipSlide(slide: Slide): boolean {
  return slide.kind === "clip" && isBuiltinClipId(slide.clip);
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
