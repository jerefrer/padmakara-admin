/**
 * Data migration: Re-parse track filenames to fix titles and speakers.
 *
 * Strips speaker abbreviations from titles (e.g., "JKR How to meditate" → "How to meditate")
 * and detects speakers that weren't previously extracted.
 *
 * Language fields (originalLanguage, languages, isTranslation) are only updated when the
 * parser explicitly detects a language marker (TRAD, bracket notation, combo). When the
 * parser merely defaults to "en", the existing DB values are preserved — this avoids
 * wrongly overriding Portuguese tracks that lack explicit markers.
 *
 * Usage: bun run src/scripts/migrate-track-languages.ts [--dry-run]
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { parseTrackFilename } from "../services/track-parser.ts";

const dryRun = process.argv.includes("--dry-run");

/** Returns true if the parser found an explicit language marker (not just default "en") */
function hasExplicitLanguage(filename: string): boolean {
  const base = filename.replace(/\.(mp3|wav|m4a|flac|ogg|mpeg)$/i, "");
  // TRAD marker
  if (/(?:^|\s|_)TRAD(?:\s|$|-)/i.test(base)) return true;
  // Bracket language: [TIB], [ENG], [POR], etc.
  if (/\[[A-Z]+(?:\s*-\s*[^\]]+)?\]/i.test(base)) return true;
  // Combo with TRAD: JKR+TRAD, TRAD+JKR, PWR&TRAD, etc.
  if (/[A-Z]{2,5}[+&]TRAD|TRAD[+&][A-Z]{2,5}/i.test(base)) return true;
  return false;
}

async function main() {
  console.log("=== Migrate Track Titles & Speakers ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);

  const allTracks = await db
    .select({
      id: tracks.id,
      title: tracks.title,
      originalFilename: tracks.originalFilename,
      languages: tracks.languages,
      originalLanguage: tracks.originalLanguage,
      isTranslation: tracks.isTranslation,
      speaker: tracks.speaker,
    })
    .from(tracks);

  console.log(`Found ${allTracks.length} tracks to process`);

  let updated = 0;
  let skipped = 0;
  let noFilename = 0;

  for (const track of allTracks) {
    if (!track.originalFilename) {
      noFilename++;
      continue;
    }

    const parsed = parseTrackFilename(track.originalFilename);
    const explicitLang = hasExplicitLanguage(track.originalFilename);

    // Always compare title and speaker
    const titleSame = parsed.title === track.title;
    // Only update speaker if parser found one — don't clear existing speakers
    const speakerSame = !parsed.speaker
      ? true // parser didn't detect speaker, keep existing
      : parsed.speaker === (track.speaker ?? null);

    // Only compare language fields if parser explicitly detected a marker
    const langsSame = !explicitLang || (
      JSON.stringify(parsed.languages.sort()) ===
      JSON.stringify([...track.languages].sort())
    );
    const origLangSame = !explicitLang || parsed.originalLanguage === track.originalLanguage;
    const transSame = !explicitLang || parsed.isTranslation === track.isTranslation;

    if (titleSame && speakerSame && langsSame && origLangSame && transSame) {
      skipped++;
      continue;
    }

    // Build update payload
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (!titleSame) updates.title = parsed.title;
    if (!speakerSame && parsed.speaker) updates.speaker = parsed.speaker;
    if (explicitLang) {
      if (!langsSame) updates.languages = parsed.languages;
      if (!origLangSame) updates.originalLanguage = parsed.originalLanguage;
      if (!transSame) updates.isTranslation = parsed.isTranslation;
    }

    if (!dryRun) {
      await db
        .update(tracks)
        .set(updates)
        .where(eq(tracks.id, track.id));
    }

    updated++;

    if (!titleSame) {
      console.log(`  [${track.id}] title: "${track.title}" → "${parsed.title}"`);
    }
    if (!speakerSame) {
      console.log(`  [${track.id}] speaker: ${track.speaker || "(none)"} → ${parsed.speaker || "(none)"}`);
    }
    if (explicitLang && (!langsSame || !origLangSame)) {
      console.log(
        `  [${track.id}] ${track.originalFilename}` +
          ` | langs: [${track.languages}] → [${parsed.languages}]` +
          ` | orig: ${track.originalLanguage} → ${parsed.originalLanguage}` +
          ` | trans: ${track.isTranslation} → ${parsed.isTranslation}`,
      );
    }
  }

  console.log(`\nResults:`);
  console.log(`  Updated:     ${updated}`);
  console.log(`  Skipped:     ${skipped} (no change)`);
  console.log(`  No filename: ${noFilename}`);
  console.log(`  Total:       ${allTracks.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
