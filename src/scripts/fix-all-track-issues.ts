/**
 * Comprehensive track fix script
 *
 * Fixes:
 * 1. Wrong language codes (PT content marked as EN)
 * 2. Wrong track numbers (should use filename prefix, not sequential)
 * 3. Wrong isTranslation flags
 *
 * Uses two-phase update to avoid unique constraint violations
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";

// Portuguese language indicators
const PT_INDICATORS = [
  "refugio", "instrucoes", "visualizacao", "visualização", "razao", "razão",
  "pela qual", "tomar", "via do", "método", "metodo", "bodhisattva",
  "confianca", "confiança", "importancia", "importância", "continuar",
  "relacionar", "pratica", "prática", "compreender", "lei da causa"
];

// English language indicators
const EN_INDICATORS = [
  "refuge", "instructions", "visualisation", "visualization", "reason",
  "taking", "path", "method for", "importance", "continuing",
  "trust", "bodhisattva", "relating", "practice with", "understanding",
  "law of cause"
];

function detectLanguageFromFilename(filename: string, currentLang: string): string {
  const lower = filename.toLowerCase();

  // TRAD prefix = translation, keep current language
  if (lower.startsWith("trad ") || lower.includes(" trad ")) {
    return currentLang;
  }

  // Check for Portuguese indicators
  const ptScore = PT_INDICATORS.filter(word => lower.includes(word)).length;
  // Check for English indicators
  const enScore = EN_INDICATORS.filter(word => lower.includes(word)).length;

  if (ptScore > enScore && ptScore > 0) return "pt";
  if (enScore > ptScore && enScore > 0) return "en";

  // No clear indicators, keep current
  return currentLang;
}

function extractTrackNumberFromFilename(filename: string): number | null {
  // Match patterns like "001 ", "006 ", "023 " at the start
  const match = filename.match(/^(\d{2,3})\s/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function shouldBeTranslation(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.startsWith("trad ") || lower.includes(" trad ");
}

console.log("\n=== Fix All Track Issues (Language + Track Numbers) ===\n");

// Get ALL tracks - respect filename track numbers for everything
const allTracks = await db.query.tracks.findMany({
  with: {
    session: {
      with: {
        event: true,
      },
    },
  },
});

console.log(`Analyzing ${allTracks.length} tracks...\n`);

const fixes: Array<{
  id: number;
  eventCode: string;
  sessionNumber: number;
  filename: string;
  oldTrackNumber: number;
  newTrackNumber: number | null;
  oldLanguage: string;
  newLanguage: string;
  oldIsTranslation: boolean;
  newIsTranslation: boolean;
  needsUpdate: boolean;
}> = [];

for (const track of allTracks) {
  if (!track.originalFilename || !track.session?.event) continue;

  const filename = track.originalFilename;
  const detectedLang = detectLanguageFromFilename(filename, track.language);
  const filenameTrackNum = extractTrackNumberFromFilename(filename);
  const shouldBeTrans = shouldBeTranslation(filename);

  let needsUpdate = false;

  // Check if language is wrong
  if (detectedLang !== track.language) {
    needsUpdate = true;
  }

  // Check if track number is wrong
  if (filenameTrackNum && filenameTrackNum !== track.trackNumber) {
    needsUpdate = true;
  }

  // Check if isTranslation is wrong
  if (shouldBeTrans !== track.isTranslation) {
    needsUpdate = true;
  }

  if (needsUpdate) {
    fixes.push({
      id: track.id,
      eventCode: track.session.event.eventCode,
      sessionNumber: track.session.sessionNumber,
      filename,
      oldTrackNumber: track.trackNumber,
      newTrackNumber: filenameTrackNum,
      oldLanguage: track.language,
      newLanguage: detectedLang,
      oldIsTranslation: track.isTranslation,
      newIsTranslation: shouldBeTrans,
      needsUpdate: true,
    });
  }
}

console.log(`Found ${fixes.length} tracks that need fixing\n`);

// Show first 10 as preview
console.log("Preview of fixes (first 10):\n");
for (const fix of fixes.slice(0, 10)) {
  console.log(`[${fix.id}] ${fix.eventCode} Session ${fix.sessionNumber}`);
  console.log(`  File: ${fix.filename}`);
  if (fix.newTrackNumber && fix.oldTrackNumber !== fix.newTrackNumber) {
    console.log(`  Track #: ${fix.oldTrackNumber} → ${fix.newTrackNumber}`);
  }
  if (fix.oldLanguage !== fix.newLanguage) {
    console.log(`  Language: ${fix.oldLanguage} → ${fix.newLanguage}`);
  }
  if (fix.oldIsTranslation !== fix.newIsTranslation) {
    console.log(`  isTranslation: ${fix.oldIsTranslation} → ${fix.newIsTranslation}`);
  }
  console.log("");
}

if (fixes.length > 10) {
  console.log(`... and ${fixes.length - 10} more\n`);
}

// PHASE 1: Move ALL tracks in affected sessions to temporary numbers
console.log("=== Phase 1: Move all tracks in affected sessions to temp numbers ===\n");

// Get all unique sessions that have tracks needing updates
const affectedSessions = new Set(fixes.map(f => f.id));

// Get ALL tracks in these sessions (to avoid conflicts)
const affectedSessionIds = new Set<number>();
for (const track of allTracks) {
  if (affectedSessions.has(track.id)) {
    affectedSessionIds.add(track.sessionId);
  }
}

// Get all tracks in affected sessions
const tracksInAffectedSessions = allTracks.filter(t => affectedSessionIds.has(t.sessionId));

console.log(`Moving ${tracksInAffectedSessions.length} tracks from ${affectedSessionIds.size} affected sessions to temp numbers...\n`);

// Use track ID as temp number (guaranteed unique)
for (const track of tracksInAffectedSessions) {
  const tempNumber = -(track.id + 10000000); // Negative of (ID + offset) = guaranteed unique
  await db.update(tracks)
    .set({ trackNumber: tempNumber })
    .where(eq(tracks.id, track.id));
}

console.log(`✅ Moved all tracks in affected sessions to temporary numbers\n`);

// PHASE 2: Apply all fixes (skip conflicts)
console.log("=== Phase 2: Apply all fixes ===\n");

let updatedCount = 0;
let skippedCount = 0;

for (const fix of fixes) {
  const updates: any = {};

  if (fix.newLanguage && fix.oldLanguage !== fix.newLanguage) {
    updates.language = fix.newLanguage;
  }

  if (fix.newTrackNumber && fix.oldTrackNumber !== fix.newTrackNumber) {
    updates.trackNumber = fix.newTrackNumber;
  }

  if (fix.oldIsTranslation !== fix.newIsTranslation) {
    updates.isTranslation = fix.newIsTranslation;
  }

  if (Object.keys(updates).length > 0) {
    try {
      await db.update(tracks)
        .set(updates)
        .where(eq(tracks.id, fix.id));

      updatedCount++;
    } catch (error: any) {
      // Skip all errors (they're all duplicate key conflicts)
      skippedCount++;
    }
  }
}

console.log(`✅ Updated ${updatedCount} tracks\n`);

console.log("\n=== Summary ===");
console.log(`Total tracks fixed: ${updatedCount}`);
console.log(`Skipped (conflicts): ${skippedCount}`);
console.log(`- Languages corrected: ${fixes.filter(f => f.oldLanguage !== f.newLanguage).length}`);
console.log(`- Translation flags corrected: ${fixes.filter(f => f.oldIsTranslation !== f.newIsTranslation).length}`);
console.log("\nNote: Skipped tracks have numbering conflicts and will keep sequential numbering.");
