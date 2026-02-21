/**
 * Fix transcript language codes based on filename patterns
 *
 * Detects language from brackets in filename like [Eng], [FR], [POR]
 * and updates the language column to match
 */

import { db } from "../db/index.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { eq, or, and, sql } from "drizzle-orm";

console.log("=== Fix Transcript Language Codes ===\n");

// Find all transcripts with potential language mismatches
const allTranscripts = await db.query.transcripts.findMany({
  columns: {
    id: true,
    language: true,
    originalFilename: true,
  },
});

console.log(`Found ${allTranscripts.length} total transcripts\n`);

let fixedCount = 0;
const fixes: Array<{ id: number; filename: string; oldLang: string; newLang: string }> = [];

for (const transcript of allTranscripts) {
  if (!transcript.originalFilename) continue;

  const filename = transcript.originalFilename;
  let detectedLang: string | null = null;

  // Detect language from brackets: [Eng], [EN], [ENG], etc.
  const langMatch = filename.match(/\[(Eng|EN|ENG|English)\]/i);
  if (langMatch) {
    detectedLang = "en";
  }

  const frMatch = filename.match(/\[(FR|French|Français)\]/i);
  if (frMatch) {
    detectedLang = "fr";
  }

  const porMatch = filename.match(/\[(POR|PT|Portuguese|Português)\]/i);
  if (porMatch) {
    detectedLang = "pt";
  }

  const tibMatch = filename.match(/\[(TIB|Tibetan)\]/i);
  if (tibMatch) {
    detectedLang = "tib";
  }

  // If we detected a language and it doesn't match current language
  if (detectedLang && detectedLang !== transcript.language) {
    fixes.push({
      id: transcript.id,
      filename,
      oldLang: transcript.language,
      newLang: detectedLang,
    });
  }
}

console.log(`Found ${fixes.length} transcripts with incorrect language codes:\n`);

for (const fix of fixes) {
  console.log(`  [${fix.id}] ${fix.filename}`);
  console.log(`    ${fix.oldLang} → ${fix.newLang}\n`);

  await db.update(transcripts)
    .set({ language: fix.newLang })
    .where(eq(transcripts.id, fix.id));

  fixedCount++;
}

console.log(`\n✅ Fixed ${fixedCount} transcript language codes`);
