import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import type { AnalysisResult, AnalysisTrack } from "./track-conventions.ts";

/**
 * Portuguese MP3 filenames never carry accents ("Oracoes iniciais"), so the
 * titles derived from them have none either. This step asks the model, once
 * per import, to put the European-Portuguese diacritics back. It never
 * rewrites: a reply is accepted for a title only when it equals the original
 * once accents are ignored (same words, order and letters, same casing).
 */

const MAX_TOKENS = 16000;

const SYSTEM_PROMPT =
  "You restore European Portuguese diacritics (acentos, cedilha, til) in titles of " +
  "Buddhist teaching recordings whose filenames were stripped of accents. " +
  "Change ONLY diacritics: do not correct spelling, do not change, add, remove or " +
  "reorder words, and keep the capitalisation and punctuation exactly as given. " +
  "A title that is already correct, or that is not Portuguese (for example a " +
  "Sanskrit or Tibetan term, or English), is returned unchanged. " +
  "Respond ONLY with a JSON object mapping each input key to its title, with no " +
  'markdown fences and no prose. Example: {"a": "Orações iniciais"}';

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** A track whose every spoken language is Portuguese (e.g. a TRAD dub). */
export function isPortugueseTrack(
  t: Pick<AnalysisTrack, "languages" | "originalLanguage">,
): boolean {
  if (t.languages.length > 0) return t.languages.every((l) => l === "pt");
  return t.originalLanguage === "pt";
}

export function buildAccentPrompt(titles: Record<string, string>): string {
  return "Restore the diacritics in these titles:\n\n" + JSON.stringify(titles, null, 2);
}

/**
 * Parse the model's reply and keep only safe entries: a string for a requested
 * key whose text matches the original apart from diacritics. Anything else is
 * dropped, so a hallucinated rewrite can never reach a title.
 */
export function parseAccentResponse(
  text: string,
  titles: Record<string, string>,
): Record<string, string> {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, original] of Object.entries(titles)) {
    const candidate = (parsed as Record<string, unknown>)[key];
    if (typeof candidate !== "string") continue;
    const restored = candidate.normalize("NFC");
    if (fold(restored) === fold(original)) out[key] = restored;
  }
  return out;
}

/** One batched model call. Throws on API errors; callers decide the fallback. */
export async function restoreAccents(
  client: Anthropic,
  titles: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  if (Object.keys(titles).length === 0) return {};
  const message = await client.messages
    .stream(
      {
        model: config.anthropic.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildAccentPrompt(titles) }],
      },
      { signal },
    )
    .finalMessage();
  if (message.stop_reason === "max_tokens") return {};
  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return {};
  return parseAccentResponse(block.text, titles);
}

/**
 * Restore accents on every Portuguese track title of an analysis, in one model
 * call. Changed titles are recorded as "accents" corrections and flagged
 * `titlePtAi` so the admin shows them as unreviewed AI edits. On any failure
 * the unaccented titles stay and the import carries on.
 */
export async function restoreTrackAccents(
  client: Anthropic,
  result: AnalysisResult,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  const tracks: AnalysisTrack[] = [];
  for (const s of result.sessions) {
    for (const t of s.tracks) {
      if (isPortugueseTrack(t) && t.title.trim()) tracks.push(t);
    }
  }
  if (tracks.length === 0) return result;

  // Opaque keys: filenames may contain quotes or other JSON-hostile text.
  const titles = Object.fromEntries(tracks.map((t, i) => [`t${i}`, t.title]));
  let restored: Record<string, string>;
  try {
    restored = await restoreAccents(client, titles, signal);
  } catch (e) {
    console.error("[pt-accents] accent restoration failed, keeping titles:", e);
    return result;
  }
  tracks.forEach((t, i) => {
    const next = restored[`t${i}`];
    if (next === undefined || next === t.title) return;
    t.corrections = [
      ...t.corrections,
      { field: "title", kind: "accents", before: t.title, after: next },
    ];
    t.title = next;
    t.titlePtAi = true;
  });
  return result;
}
