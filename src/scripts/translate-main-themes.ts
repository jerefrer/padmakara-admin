/**
 * Batch translate mainThemesEn for events where En === Pt (untranslated).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun src/scripts/translate-main-themes.ts
 *
 * Processes events in batches of 5 with a delay between batches to avoid rate limits.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { eq, sql } from "drizzle-orm";

const BATCH_SIZE = 5;
const DELAY_MS = 1000; // 1s between batches

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

async function translateText(ptText: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `You are translating Buddhist teaching theme descriptions from Portuguese to English. These are pipe-separated lists of teaching topics from Buddhist retreats.

Rules:
- Preserve ALL Buddhist terminology (Sanskrit, Tibetan, Pali terms) exactly as-is
- Preserve proper nouns (teacher names, place names) exactly as-is
- Preserve the pipe "|" separator structure
- Use natural, fluent English
- This is European Portuguese being translated to English
- Respond ONLY with the translated text, no explanation or formatting`,
    messages: [
      {
        role: "user",
        content: ptText,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in response");
  }
  return textBlock.text.trim();
}

async function main() {
  // Find all events where mainThemesEn === mainThemesPt
  const untranslated = await db
    .select({
      id: events.id,
      titleEn: events.titleEn,
      mainThemesPt: events.mainThemesPt,
    })
    .from(events)
    .where(
      sql`${events.mainThemesEn} = ${events.mainThemesPt} AND ${events.mainThemesEn} IS NOT NULL`,
    );

  console.log(`Found ${untranslated.length} events to translate\n`);

  let translated = 0;
  let failed = 0;

  for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
    const batch = untranslated.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (event) => {
      try {
        const enText = await translateText(event.mainThemesPt!);
        await db
          .update(events)
          .set({ mainThemesEn: enText, updatedAt: new Date() })
          .where(eq(events.id, event.id));
        translated++;
        console.log(`  [${translated + failed}/${untranslated.length}] #${event.id} "${event.titleEn}" ✓`);
      } catch (err: any) {
        failed++;
        console.error(`  [${translated + failed}/${untranslated.length}] #${event.id} FAILED: ${err.message}`);
      }
    });

    await Promise.all(promises);

    // Delay between batches
    if (i + BATCH_SIZE < untranslated.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone: ${translated} translated, ${failed} failed out of ${untranslated.length}`);
  process.exit(0);
}

main();
