/**
 * One-time migration: Populate titleEn with English translations
 * for events where titleEn === titlePt (i.e., no real English title exists).
 *
 * Usage: bun run src/scripts/translate-titles.ts [--dry-run]
 */
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { eq } from "drizzle-orm";
import { translateTitleToEnglish } from "../utils/translate-title.ts";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const allEvents = await db
    .select({ id: events.id, titleEn: events.titleEn, titlePt: events.titlePt })
    .from(events);

  let updated = 0;
  let skipped = 0;

  for (const event of allEvents) {
    // Only translate events where English = Portuguese (no real translation)
    if (event.titleEn !== event.titlePt) {
      skipped++;
      continue;
    }

    const enTitle = translateTitleToEnglish(event.titlePt!);

    // Skip if translation didn't change anything
    if (enTitle === event.titlePt) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[DRY RUN] Event ${event.id}:`);
      console.log(`  PT: ${event.titlePt}`);
      console.log(`  EN: ${enTitle}\n`);
    } else {
      await db
        .update(events)
        .set({ titleEn: enTitle })
        .where(eq(events.id, event.id));
    }
    updated++;
  }

  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Done: ${updated} events updated, ${skipped} skipped (already English or unchanged)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
