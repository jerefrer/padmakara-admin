import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "../../lib/errors.ts";
import { mapWithConcurrency } from "../../lib/concurrency.ts";
import { glossaryBlock } from "../../services/glossary.ts";

const translateRoutes = new Hono();

// Short admin fields (titles, theme summaries) — Haiku is fast and cheap and
// matches the model used by the other admin text-rewrite endpoints.
const TRANSLATE_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 8192;

// Bulk "fill Portuguese/English" on a legacy event can ask for 300+ titles at
// once. A single Claude call at 4096 tokens truncated its JSON reply and then
// failed to parse, so the request is split into batches sized to stay well
// under MAX_TOKENS. Each field translates independently, so batches need no
// shared context and run concurrently.
const BATCH_MAX_FIELDS = 40;
// Source characters per batch. Output in the other language is roughly the
// same length; 4000 chars ≈ ~1.5k output tokens, far under MAX_TOKENS even
// after JSON key overhead. A single field larger than this still forms its own
// batch (packBatches always emits at least one field per batch).
const BATCH_MAX_CHARS = 4000;
const MAX_CONCURRENT_BATCHES = 6;

const translateSchema = z.object({
  direction: z.enum(["en-to-pt", "pt-to-en"]),
  items: z
    .record(z.string(), z.string())
    .refine((o) => Object.keys(o).length > 0, "items must contain at least one field"),
});

/**
 * Greedily pack field entries into batches, closing a batch when it would
 * exceed either the field-count or source-character cap. A field longer than
 * BATCH_MAX_CHARS on its own still gets its own batch rather than being split.
 */
function packBatches(entries: [string, string][]): [string, string][][] {
  const batches: [string, string][][] = [];
  let current: [string, string][] = [];
  let chars = 0;
  for (const entry of entries) {
    const len = entry[0].length + entry[1].length;
    if (
      current.length > 0 &&
      (current.length >= BATCH_MAX_FIELDS || chars + len > BATCH_MAX_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(entry);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Translate one batch of field entries in a single Claude call. Returns the
 * subset of requested keys the model returned as strings; callers merge these.
 */
async function translateBatch(
  anthropic: Anthropic,
  fromLang: string,
  toLang: string,
  batch: [string, string][],
): Promise<Record<string, string>> {
  const prompt = batch.map(([key, source]) => `### ${key}\n${source}`).join("\n\n");

  const message = await anthropic.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: MAX_TOKENS,
    system:
      `You are translating Buddhist teaching materials from ${fromLang} to European ${toLang}. ` +
      `Preserve Buddhist terminology (dharma names, Sanskrit/Tibetan terms). Maintain structure and formatting.\n\n` +
      `${glossaryBlock()}\n\n` +
      `Respond ONLY with a JSON object mapping each input field key to its translated text. ` +
      `Example: {"title": "..."}`,
    messages: [
      {
        role: "user",
        content: `Translate the following fields from ${fromLang} to ${toLang}:\n\n${prompt}`,
      },
    ],
  });

  const textBlock = message.content.find((b: any) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from translation API");
  }
  let responseText = (textBlock as any).text.trim();
  if (responseText.startsWith("```")) {
    responseText = responseText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  let translations: unknown;
  try {
    translations = JSON.parse(responseText);
  } catch {
    throw AppError.internal("Failed to parse translation response");
  }
  const result = z.record(z.string(), z.string()).safeParse(translations);
  if (!result.success) {
    throw AppError.internal("Translation response was not an object of strings");
  }
  const data = result.data;

  // The model is asked to echo back each input field key, but it occasionally
  // renames the key of a single-field reply (e.g. copying the prompt's "title"
  // example instead of the opaque key the per-field translate button sends).
  // For a one-field batch the sole returned string is unambiguously that
  // field's translation, so map it back to the requested key rather than
  // dropping it — dropping it made the client wipe the target field and forced
  // a retry. Multi-field batches stay untouched: a mismatch there is ambiguous.
  const first = batch[0];
  if (batch.length === 1 && first && typeof data[first[0]] !== "string") {
    const values = Object.values(data);
    if (values.length === 1 && typeof values[0] === "string") {
      console.warn(
        `translate: model renamed single-field key; recovered "${first[0]}" from the returned value`,
      );
      return { [first[0]]: values[0] };
    }
    console.warn(`translate: model returned no usable value for single field "${first[0]}"`);
  }
  return data;
}

/**
 * POST /admin/translate — stateless EN<->PT translation.
 *
 * Takes an opaque map of field key -> source text and returns the same keys
 * mapped to translated text. It performs no DB writes and needs no event id,
 * so the admin form can call it on an unsaved (create) event.
 */
translateRoutes.post("/", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw AppError.badRequest("Invalid JSON body", "VALIDATION_ERROR");
  }
  const parsed = translateSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.badRequest("Validation failed", "VALIDATION_ERROR");
  }
  const { direction, items } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.internal("ANTHROPIC_API_KEY not configured");

  const fromLang = direction === "en-to-pt" ? "English" : "Portuguese";
  const toLang = direction === "en-to-pt" ? "Portuguese" : "English";

  const anthropic = new Anthropic({ apiKey });
  const batches = packBatches(Object.entries(items));
  const batchResults = await mapWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) =>
    translateBatch(anthropic, fromLang, toLang, batch),
  );
  const merged = Object.assign({}, ...batchResults) as Record<string, unknown>;

  // Return only the keys that were requested — ignore any extra/renamed keys
  // the model may have invented, so callers never receive junk fields.
  const filtered: Record<string, string> = {};
  for (const key of Object.keys(items)) {
    if (typeof merged[key] === "string") filtered[key] = merged[key] as string;
  }

  return c.json({ translations: filtered });
});

export { translateRoutes };
