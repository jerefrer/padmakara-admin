/**
 * Subtitle cues for the burned-in intro slides.
 *
 * Intro slides are burned in the video's own language; the other language
 * arrives as subtitles, so that it shows only when subtitles are on. Subtitles
 * are transcribed from the already-burned video, so the intro itself carries
 * no cues and the existing cue times already include the intro offset. That
 * makes this a pure prepend: new cues go in front, nothing existing moves.
 */

import { slideTotalMs, type SlideDocument } from "./types.ts";

const TIMING_RE = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/m;
const HEADER_BREAK_RE = /\r?\n[ \t]*\r?\n/;

function parseStartMs(block: string): number | null {
  const m = TIMING_RE.exec(block);
  if (!m) return null;
  return (
    Number(m[1] ?? 0) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4])
  );
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

/** Text lines of a cue block (everything after its timing line). */
function cueText(block: string): string {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes("-->"));
  return at < 0 ? "" : lines.slice(at + 1).join("\n");
}

interface IntroCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** One cue per intro slide that has subtitle text for `lang`, spanning the
 *  slide's full-opacity window (after its fade-in, before its fade-out). */
function introCues(slides: SlideDocument, lang: string): IntroCue[] {
  const cues: IntroCue[] = [];
  let offset = 0;
  for (const slide of slides.intro) {
    const raw = lang === "en" || lang === "pt" ? slide.subtitles?.[lang] : undefined;
    const lines = raw?.map((l) => l.trim()).filter(Boolean);
    if (lines && lines.length > 0) {
      cues.push({
        startMs: offset + slide.fadeMs,
        endMs: offset + slide.fadeMs + slide.durationMs,
        text: lines.join("\n"),
      });
    }
    offset += slideTotalMs(slide);
  }
  return cues;
}

/**
 * Prepend a cue for each intro slide that has subtitle text in `lang`.
 *
 * - Existing cues are never moved. An intro cue that would overlap the first
 *   existing cue is clipped to end where that cue starts, and dropped when
 *   nothing is left of it.
 * - Idempotent: an intro cue whose text already appears as a cue is skipped,
 *   so a VTT that was downloaded merged and uploaded again is not doubled.
 * - Header lines (WEBVTT, X-TIMESTAMP-MAP) stay at the top.
 * - Outro slides are ignored. With no document or no subtitles for `lang`,
 *   the input is returned unchanged.
 */
export function mergeIntroSubtitleCues(
  vtt: string,
  slides: SlideDocument | null | undefined,
  lang: string,
): string {
  if (!slides) return vtt;
  const candidates = introCues(slides, lang);
  if (candidates.length === 0) return vtt;

  const eol = vtt.includes("\r\n") ? "\r\n" : "\n";
  const hasHeader = /^﻿?WEBVTT/.test(vtt);
  const source = hasHeader ? vtt : `WEBVTT${eol}${eol}${vtt}`;
  const brk = HEADER_BREAK_RE.exec(source);
  const head = (brk ? source.slice(0, brk.index) : source).trimEnd();
  const rest = brk ? source.slice(brk.index + brk[0].length).trim() : "";

  const blocks = rest ? rest.split(/\r?\n(?:[ \t]*\r?\n)+/) : [];
  const existingTexts = new Set(blocks.map(cueText).filter(Boolean));
  const fresh = candidates.filter((c) => !existingTexts.has(c.text));
  if (fresh.length === 0) return vtt;

  // Clip against the first real cue, ignoring cues that are intro cues from an
  // earlier merge.
  const introTexts = new Set(candidates.map((c) => c.text));
  const starts = blocks
    .filter((b) => !introTexts.has(cueText(b)))
    .map(parseStartMs)
    .filter((n): n is number => n !== null);
  const firstStart = starts.length > 0 ? Math.min(...starts) : Infinity;

  const added = fresh
    .map((c) => ({ ...c, endMs: Math.min(c.endMs, firstStart) }))
    .filter((c) => c.endMs > c.startMs)
    .map((c) => `${formatMs(c.startMs)} --> ${formatMs(c.endMs)}${eol}${c.text.split("\n").join(eol)}`);
  if (added.length === 0) return vtt;

  const out = [head, ...added, ...(rest ? [rest] : [])].join(eol + eol);
  return out.endsWith(eol) ? out : out + eol;
}
