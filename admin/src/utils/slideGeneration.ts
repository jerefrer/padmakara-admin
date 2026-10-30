/**
 * Client side of "Generate from event data": one request helper shared by the
 * event-scoped (draft) and video-scoped (saved video) routes, so both get the
 * same timeout and the same error vocabulary, plus the helpers that turn the
 * server's `missing` list into something the editor can say.
 */

import type { MissingSlideInput, SlideLanguage } from "@slides/defaults.ts";
import type { SlideDocument } from "@slides/types.ts";
import { authFetch } from "./authFetch";

export type { MissingSlideInput, SlideLanguage };

export const SLIDE_GENERATION_TIMEOUT_MS = 30_000;

/** Every input the default intro can draw on; all missing means nothing but the logo. */
export const ALL_SLIDE_INPUTS: readonly MissingSlideInput[] = [
  "teacher",
  "title",
  "date",
  "place",
  "session",
  "organizer",
  "production",
];

export interface GeneratedSlides {
  slides: SlideDocument;
  /** Absent when talking to a server that predates the field. */
  missing: MissingSlideInput[];
  language: SlideLanguage;
}

export type SlideGenerationErrorKind = "timeout" | "http" | "network";

export class SlideGenerationError extends Error {
  constructor(
    readonly kind: SlideGenerationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SlideGenerationError";
  }
}

/**
 * POST to a slides/defaults route and parse the answer. Aborts after
 * `timeoutMs` so a hung request surfaces as an error rather than a dialog
 * that looks frozen.
 */
export async function requestDefaultSlides(
  url: string,
  body: { lang: SlideLanguage },
  timeoutMs: number = SLIDE_GENERATION_TIMEOUT_MS,
): Promise<GeneratedSlides> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new SlideGenerationError("http", `HTTP ${res.status}`);
    const data = (await res.json()) as Partial<GeneratedSlides> & { slides: SlideDocument };
    return { slides: data.slides, missing: data.missing ?? [], language: data.language ?? body.lang };
  } catch (err) {
    if (err instanceof SlideGenerationError) throw err;
    if (controller.signal.aborted) {
      throw new SlideGenerationError("timeout", `No answer after ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new SlideGenerationError("network", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** True when the event gave the generator nothing but the built-in logo. */
export function nothingToGenerateFrom(missing: readonly MissingSlideInput[]): boolean {
  return ALL_SLIDE_INPUTS.every((key) => missing.includes(key));
}
