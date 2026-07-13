import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "../../lib/errors.ts";
import { glossaryBlock } from "../../services/glossary.ts";

const translateRoutes = new Hono();

// Short admin fields (titles, theme summaries) — Haiku is fast and cheap and
// matches the model used by the other admin text-rewrite endpoints.
const TRANSLATE_MODEL = "claude-haiku-4-5-20251001";

const translateSchema = z.object({
  direction: z.enum(["en-to-pt", "pt-to-en"]),
  items: z
    .record(z.string(), z.string())
    .refine((o) => Object.keys(o).length > 0, "items must contain at least one field"),
});

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
  const prompt = Object.entries(items)
    .map(([key, source]) => `### ${key}\n${source}`)
    .join("\n\n");

  const message = await anthropic.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 4096,
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

  // Return only the keys that were requested — ignore any extra/renamed keys
  // the model may have invented, so callers never receive junk fields.
  const filtered: Record<string, string> = {};
  for (const key of Object.keys(items)) {
    if (typeof result.data[key] === "string") filtered[key] = result.data[key];
  }

  return c.json({ translations: filtered });
});

export { translateRoutes };
