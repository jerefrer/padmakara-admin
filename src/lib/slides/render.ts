/**
 * Shared slide renderer — slide document in, standalone HTML out.
 *
 * This is deliberately the ONLY implementation of slide layout. The admin
 * preview renders this HTML in an iframe, and the burn container screenshots
 * the very same HTML with headless Chromium before handing the frames to
 * ffmpeg. One renderer means the preview cannot drift from the burned result.
 *
 * All measurements are expressed as a percentage of frame height, so a slide
 * laid out for a 640px-wide admin preview is pixel-proportional to the same
 * slide rendered at 1920x1080 (or whatever the master's real resolution is).
 * The trick: root font-size is set to 1% of frame height, so `3rem` reads as
 * "3% of the frame".
 */

import type { Line, Slide, Span } from "./types.ts";

/** Type scale, in percent of frame height. Derived by measuring the existing
 *  Padmakara intro slides — see the spec for the sampled figures. */
const SIZE_SCALE: Record<string, number> = {
  sm: 3.0,
  md: 4.0,
  lg: 5.0,
  xl: 6.5,
};

/** Gap between consecutive lines, in percent of frame height. */
const LINE_GAP = 1.4;

/** A spacer's height, in percent of frame height. */
const SPACER_HEIGHT = 4.0;

/** Images never exceed this share of the frame height, however much space is free. */
const IMAGE_MAX_HEIGHT_PCT = 60;

/** Opacity applied to `dim` lines. Matches the date slide in the reference intro. */
const DIM_OPACITY = 0.75;

export interface RenderOptions {
  /** Frame size in pixels. The container passes the master's real dimensions. */
  width: number;
  height: number;
  /**
   * Base URL the four MinionPro faces are served from, with a trailing slash.
   * Admin passes a served path (`/fonts/`); the container passes a `file://` URL.
   */
  fontBaseUrl: string;
  /** Resolves an image line's storage key to a URL the renderer can load. */
  resolveImageUrl: (s3Key: string) => string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSpan(span: Span): string {
  let html = escapeHtml(span.text);
  // Order matters only for readability of the output; nesting is equivalent.
  if (span.bold) html = `<strong>${html}</strong>`;
  if (span.italic) html = `<em>${html}</em>`;
  if (span.underline) html = `<u>${html}</u>`;
  return html;
}

function renderLine(line: Line, opts: RenderOptions): string {
  switch (line.type) {
    case "spacer":
      return `<div class="spacer"></div>`;

    case "image": {
      const src = escapeHtml(opts.resolveImageUrl(line.s3Key));
      const alt = escapeHtml(line.alt ?? "");
      return `<div class="img-line"><img src="${src}" alt="${alt}"></div>`;
    }

    case "text": {
      const size = SIZE_SCALE[line.size] ?? SIZE_SCALE.md;
      const cls = line.dim ? "text-line dim" : "text-line";
      const inner = line.spans.map(renderSpan).join("");
      // An empty text line would collapse; a zero-width space keeps its box.
      const content = inner === "" ? "&#8203;" : inner;
      return `<div class="${cls}" style="font-size:${size}rem">${content}</div>`;
    }
  }
}

function fontFace(family: string, file: string, weight: string, style: string, base: string): string {
  return `@font-face{font-family:"${family}";src:url("${base}${file}") format("opentype");font-weight:${weight};font-style:${style};font-display:block;}`;
}

/**
 * Render one slide to a complete, self-contained HTML document.
 *
 * The document has no scripts and no external requests beyond the font files
 * and any image lines, so Chromium can screenshot it as soon as fonts and
 * images report loaded.
 */
export function renderSlideHtml(slide: Slide, opts: RenderOptions): string {
  const { width, height, fontBaseUrl } = opts;
  // 1rem === 1% of frame height, so every measurement below is proportional.
  const rootFontSize = height / 100;

  const fonts = [
    fontFace("MinionPro", "MinionPro-Regular.otf", "400", "normal", fontBaseUrl),
    fontFace("MinionPro", "MinionPro-It.otf", "400", "italic", fontBaseUrl),
    fontFace("MinionPro", "MinionPro-Bold.otf", "700", "normal", fontBaseUrl),
    fontFace("MinionPro", "MinionPro-BoldIt.otf", "700", "italic", fontBaseUrl),
  ].join("");

  const lines = slide.lines.map((line) => renderLine(line, opts)).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${fonts}
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:${rootFontSize}px}
body{
  width:${width}px;height:${height}px;
  background:#000;color:#fff;
  font-family:"MinionPro",Georgia,serif;
  /* Chromium renders text noticeably heavier without this; the reference
     slides are fine-stroked, so keep antialiasing subtle. */
  -webkit-font-smoothing:antialiased;
  overflow:hidden;
}
.stage{
  width:100%;height:100%;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  gap:${LINE_GAP}rem;
  /* Keeps long lines off the frame edge at any resolution. */
  padding:0 8%;
}
.text-line{
  flex:0 0 auto;
  text-align:center;
  line-height:1.25;
  white-space:pre-wrap;
}
.dim{opacity:${DIM_OPACITY}}
.spacer{flex:0 0 auto;height:${SPACER_HEIGHT}rem}
/* Image lines share whatever vertical space the text lines leave over.
   min-height:0 is required or flex refuses to shrink them below content size. */
.img-line{
  flex:1 1 auto;min-height:0;
  width:100%;
  display:flex;align-items:center;justify-content:center;
}
.img-line img{
  max-width:100%;
  max-height:min(100%, ${IMAGE_MAX_HEIGHT_PCT}rem);
  object-fit:contain;
}
</style></head>
<body><div class="stage">${lines}</div></body></html>`;
}

/**
 * Timing for one slide as an ffmpeg-friendly breakdown. The container uses this
 * to build the fade filter; the admin preview uses it to drive its playback.
 */
export interface SlideTiming {
  fadeInMs: number;
  holdMs: number;
  fadeOutMs: number;
  totalMs: number;
}

export function slideTiming(slide: Slide): SlideTiming {
  return {
    fadeInMs: slide.fadeMs,
    holdMs: slide.durationMs,
    fadeOutMs: slide.fadeMs,
    totalMs: slide.fadeMs * 2 + slide.durationMs,
  };
}
