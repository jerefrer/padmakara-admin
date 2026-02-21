/**
 * Fix tracks where speaker abbreviations are in the filename but not in the speaker field
 *
 * Detects patterns like:
 * - "001 JKR something" (speaker after track number without dash)
 * - "RR 01_02 morning" (RR at beginning)
 * - "001_JKR_title" (underscores)
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq, isNull, or } from "drizzle-orm";

// Common speaker abbreviations from teachers table
// Note: TRAD is NOT a speaker - it's tied to isTranslation flag
const KNOWN_SPEAKERS = [
  "JKR", "PWR", "RR", "TRR", "KPS", "PPR", "RM", "DKR",
  "LT", "PT", "SR", "MR", "DR", "CR", "FR", "NR", "ER"
];

function detectSpeakerFromFilename(filename: string): string | null {
  const upper = filename.toUpperCase();

  // Pattern 1: "001 SPEAKER - title" or "001 SPEAKER title"
  const pattern1 = filename.match(/^\d+[_\s-]+([A-Z]{2,5})(?:\s*-\s|\s+)/i);
  if (pattern1) {
    const abbrev = pattern1[1]!.toUpperCase();
    if (KNOWN_SPEAKERS.includes(abbrev)) {
      return abbrev;
    }
  }

  // Pattern 2: "SPEAKER 01_02" (speaker at beginning)
  const pattern2 = filename.match(/^([A-Z]{2,5})\s+\d{1,2}[_\s]\d{1,2}/i);
  if (pattern2) {
    const abbrev = pattern2[1]!.toUpperCase();
    if (KNOWN_SPEAKERS.includes(abbrev)) {
      return abbrev;
    }
  }

  // Pattern 3: Check if any known speaker appears early in filename
  for (const speaker of KNOWN_SPEAKERS) {
    // Match speaker at start or after track number
    const regex = new RegExp(`(?:^|^\\d+[_\\s-]+)${speaker}(?:[_\\s-]|$)`, 'i');
    if (regex.test(filename)) {
      return speaker;
    }
  }

  return null;
}

console.log("\n=== Fix Missing Speaker Attributions ===\n");

// Get all tracks where speaker is null or empty
const allTracks = await db.query.tracks.findMany({
  where: (t: any, { or, eq, isNull }: any) =>
    or(
      isNull(t.speaker),
      eq(t.speaker, "")
    ),
  with: {
    session: {
      with: {
        event: true,
      },
    },
  },
});

console.log(`Analyzing ${allTracks.length} tracks with missing speaker...\n`);

const fixes: Array<{
  id: number;
  eventCode: string;
  sessionNumber: number;
  filename: string;
  detectedSpeaker: string;
}> = [];

for (const track of allTracks) {
  if (!track.originalFilename || !track.session?.event) continue;

  const detectedSpeaker = detectSpeakerFromFilename(track.originalFilename);

  if (detectedSpeaker) {
    fixes.push({
      id: track.id,
      eventCode: track.session.event.eventCode,
      sessionNumber: track.session.sessionNumber,
      filename: track.originalFilename,
      detectedSpeaker,
    });
  }
}

console.log(`Found ${fixes.length} tracks with detectable speakers\n`);

// Show first 20 as preview
console.log("Preview of fixes (first 20):\n");
for (const fix of fixes.slice(0, 20)) {
  console.log(`[${fix.id}] ${fix.eventCode} Session ${fix.sessionNumber}`);
  console.log(`  File: ${fix.filename}`);
  console.log(`  Speaker: ${fix.detectedSpeaker}`);
  console.log("");
}

if (fixes.length > 20) {
  console.log(`... and ${fixes.length - 20} more\n`);
}

// Apply fixes
console.log("=== Applying Fixes ===\n");

let updatedCount = 0;

for (const fix of fixes) {
  try {
    await db.update(tracks)
      .set({ speaker: fix.detectedSpeaker })
      .where(eq(tracks.id, fix.id));

    updatedCount++;
  } catch (error: any) {
    console.error(`Failed to update track ${fix.id}: ${error.message}`);
  }
}

console.log(`✅ Updated ${updatedCount} tracks with speaker attributions\n`);

// Show summary by speaker
const speakerCounts = fixes.reduce((acc, fix) => {
  acc[fix.detectedSpeaker] = (acc[fix.detectedSpeaker] || 0) + 1;
  return acc;
}, {} as Record<string, number>);

console.log("Summary by speaker:");
for (const [speaker, count] of Object.entries(speakerCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${speaker}: ${count} tracks`);
}
