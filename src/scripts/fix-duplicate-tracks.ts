/**
 * Fix duplicate/misparsed tracks across all events
 *
 * Issues to fix:
 * 1. Tracks with wrong language detection (PT content marked as EN)
 * 2. Tracks with wrong track numbers (sequential vs filename prefix)
 * 3. True duplicates (same content, different IDs)
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";

// Portuguese language indicators
const PT_INDICATORS = [
  "refugio", "instrucoes", "visualizacao", "razao", "pela qual",
  "tomar", "via do", "metodo para", "bodhisattva", "confianca",
  "importancia", "continuar"
];

// English language indicators
const EN_INDICATORS = [
  "refuge", "instructions", "visualisation", "visualization", "reason",
  "taking", "path", "method for", "importance", "continuing",
  "trust", "bodhisattva"
];

function detectLanguageFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase();

  // Check for Portuguese indicators
  const ptScore = PT_INDICATORS.filter(word => lower.includes(word)).length;
  // Check for English indicators
  const enScore = EN_INDICATORS.filter(word => lower.includes(word)).length;

  if (ptScore > enScore && ptScore > 0) return "pt";
  if (enScore > ptScore && enScore > 0) return "en";

  // Check for common Portuguese vs English words
  if (lower.includes("trad ")) return null; // Translation marker, keep existing language

  return null; // Can't determine
}

function extractTrackNumberFromFilename(filename: string): number | null {
  // Match patterns like "006 ", "023 ", etc. at the start
  const match = filename.match(/^(\d{2,3})\s/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

console.log("\n=== Fix Duplicate/Misparsed Tracks ===\n");

// Get all tracks
const allTracks = await db.query.tracks.findMany({
  with: {
    session: {
      with: {
        event: true,
      },
    },
  },
});

console.log(`Analyzing ${allTracks.length} total tracks...\n`);

const fixes: Array<{
  id: number;
  eventCode: string;
  sessionNumber: number;
  oldTrackNumber: number;
  newTrackNumber: number | null;
  oldLanguage: string;
  newLanguage: string | null;
  filename: string;
  action: "update_language" | "update_track_number" | "update_both";
}> = [];

const deletions: Array<{
  id: number;
  eventCode: string;
  sessionNumber: number;
  filename: string;
  reason: string;
}> = [];

for (const track of allTracks) {
  if (!track.originalFilename || !track.session?.event) continue;

  const filename = track.originalFilename;
  const detectedLang = detectLanguageFromFilename(filename);
  const filenameTrackNum = extractTrackNumberFromFilename(filename);

  let needsUpdate = false;
  let action: "update_language" | "update_track_number" | "update_both" | null = null;

  // Check if language is wrong
  if (detectedLang && detectedLang !== track.language) {
    needsUpdate = true;
    action = "update_language";
  }

  // Check if track number is wrong
  if (filenameTrackNum && filenameTrackNum !== track.trackNumber) {
    needsUpdate = true;
    action = action === "update_language" ? "update_both" : "update_track_number";
  }

  if (needsUpdate && action) {
    fixes.push({
      id: track.id,
      eventCode: track.session.event.eventCode,
      sessionNumber: track.session.sessionNumber,
      oldTrackNumber: track.trackNumber,
      newTrackNumber: filenameTrackNum,
      oldLanguage: track.language,
      newLanguage: detectedLang,
      filename,
      action,
    });
  }
}

console.log(`Found ${fixes.length} tracks that need fixing:\n`);

// Group by event
const byEvent = new Map<string, typeof fixes>();
for (const fix of fixes) {
  if (!byEvent.has(fix.eventCode)) {
    byEvent.set(fix.eventCode, []);
  }
  byEvent.get(fix.eventCode)!.push(fix);
}

for (const [eventCode, eventFixes] of byEvent.entries()) {
  console.log(`\n${eventCode}: ${eventFixes.length} fixes`);
  for (const fix of eventFixes.slice(0, 5)) { // Show first 5 as examples
    console.log(`  [${fix.id}] Session ${fix.sessionNumber}, Track ${fix.oldTrackNumber}`);
    console.log(`    File: ${fix.filename}`);
    if (fix.action === "update_language" || fix.action === "update_both") {
      console.log(`    Language: ${fix.oldLanguage} → ${fix.newLanguage}`);
    }
    if (fix.action === "update_track_number" || fix.action === "update_both") {
      console.log(`    Track #: ${fix.oldTrackNumber} → ${fix.newTrackNumber}`);
    }
  }
  if (eventFixes.length > 5) {
    console.log(`    ... and ${eventFixes.length - 5} more`);
  }
}

// Now apply the fixes
console.log(`\n\n=== Applying Fixes ===\n`);

let updatedCount = 0;

for (const fix of fixes) {
  const updates: any = {};

  if (fix.newLanguage && (fix.action === "update_language" || fix.action === "update_both")) {
    updates.language = fix.newLanguage;
  }

  if (fix.newTrackNumber && (fix.action === "update_track_number" || fix.action === "update_both")) {
    updates.trackNumber = fix.newTrackNumber;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(tracks)
      .set(updates)
      .where(eq(tracks.id, fix.id));

    updatedCount++;
  }
}

console.log(`✅ Updated ${updatedCount} tracks\n`);

// Now find and remove TRUE duplicates (same session, track number, language, but different IDs)
console.log("\n=== Finding True Duplicates After Fixes ===\n");

const sessionsToCheck = new Set<number>();
for (const fix of fixes) {
  const track = allTracks.find(t => t.id === fix.id);
  if (track) {
    sessionsToCheck.add(track.sessionId);
  }
}

console.log(`Checking ${sessionsToCheck.size} sessions for duplicates...\n`);

const duplicatesToDelete: number[] = [];

for (const sessionId of sessionsToCheck) {
  const sessionTracks = await db.query.tracks.findMany({
    where: eq(tracks.sessionId, sessionId),
    with: { session: { with: { event: true } } },
  });

  // Group by track number + language
  const groups = new Map<string, typeof sessionTracks>();
  for (const track of sessionTracks) {
    const key = `${track.trackNumber}-${track.language}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(track);
  }

  // Find duplicates
  for (const [key, groupTracks] of groups.entries()) {
    if (groupTracks.length > 1) {
      // Multiple tracks with same track number and language
      // Keep the one marked as translation if one exists, otherwise keep the first
      const translations = groupTracks.filter(t => t.isTranslation);
      const nonTranslations = groupTracks.filter(t => !t.isTranslation);

      let toKeep: typeof groupTracks[0];
      let toDelete: typeof groupTracks = [];

      if (translations.length === 1 && nonTranslations.length >= 1) {
        // If there's exactly 1 translation and 1+ non-translations
        // This is likely a misparsed duplicate - keep the translation, delete non-translation
        toKeep = translations[0];
        toDelete = nonTranslations;
      } else if (translations.length === 0 && nonTranslations.length > 1) {
        // Multiple non-translations - keep the one with speaker, or the first
        const withSpeaker = nonTranslations.filter(t => t.speaker);
        toKeep = withSpeaker.length > 0 ? withSpeaker[0] : nonTranslations[0];
        toDelete = nonTranslations.filter(t => t.id !== toKeep.id);
      } else {
        // Complex case - keep the first, delete the rest
        toKeep = groupTracks[0];
        toDelete = groupTracks.slice(1);
      }

      for (const track of toDelete) {
        console.log(`  Duplicate: [${track.id}] ${track.session?.event?.eventCode} Session ${track.session?.sessionNumber} Track ${track.trackNumber} (${track.language})`);
        console.log(`    File: ${track.originalFilename}`);
        console.log(`    Keeping: [${toKeep.id}] ${toKeep.originalFilename}`);
        duplicatesToDelete.push(track.id);
      }
    }
  }
}

if (duplicatesToDelete.length > 0) {
  console.log(`\nDeleting ${duplicatesToDelete.length} duplicate tracks...`);

  for (const id of duplicatesToDelete) {
    await db.delete(tracks).where(eq(tracks.id, id));
  }

  console.log(`✅ Deleted ${duplicatesToDelete.length} duplicates\n`);
} else {
  console.log("No duplicates found after fixes!\n");
}

console.log("\n=== Summary ===");
console.log(`Updated: ${updatedCount} tracks`);
console.log(`Deleted: ${duplicatesToDelete.length} duplicates`);
console.log(`Events affected: ${byEvent.size}`);
