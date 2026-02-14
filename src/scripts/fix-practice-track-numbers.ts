/**
 * Fix practice tracks with negative track numbers
 *
 * Practice tracks should:
 * 1. Use the track number from their filename if present
 * 2. NOT use negative numbers - they sort normally with other tracks
 * 3. isPractice is manual-only, not automatic
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq, lt } from "drizzle-orm";

function extractTrackNumberFromFilename(filename: string): number | null {
  // Match patterns like "001 ", "006 ", "023 " at the start
  const match = filename.match(/^(\d{2,3})\s/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

console.log("\n=== Fix Practice Track Numbers ===\n");

// Get all tracks with negative track numbers
const negativeTracks = await db.query.tracks.findMany({
  where: lt(tracks.trackNumber, 0),
  with: {
    session: {
      with: {
        event: true,
      },
    },
  },
});

console.log(`Found ${negativeTracks.length} tracks with negative track numbers\n`);

const fixes: Array<{
  id: number;
  eventCode: string;
  sessionNumber: number;
  sessionId: number;
  filename: string;
  currentTrackNumber: number;
  newTrackNumber: number;
}> = [];

for (const track of negativeTracks) {
  if (!track.originalFilename || !track.session?.event) continue;

  const filenameTrackNum = extractTrackNumberFromFilename(track.originalFilename);

  let newTrackNumber: number;
  if (filenameTrackNum !== null) {
    // Use the track number from filename
    newTrackNumber = filenameTrackNum;
  } else {
    // Make it positive (absolute value)
    newTrackNumber = Math.abs(track.trackNumber);
  }

  if (newTrackNumber !== track.trackNumber) {
    fixes.push({
      id: track.id,
      eventCode: track.session.event.eventCode,
      sessionNumber: track.session.sessionNumber,
      sessionId: track.sessionId,
      filename: track.originalFilename,
      currentTrackNumber: track.trackNumber,
      newTrackNumber,
    });
  }
}

console.log(`Found ${fixes.length} tracks that need fixing\n`);

// Show preview
console.log("Preview of fixes (first 20):\n");
for (const fix of fixes.slice(0, 20)) {
  console.log(`[${fix.id}] ${fix.eventCode} Session ${fix.sessionNumber}`);
  console.log(`  File: ${fix.filename}`);
  console.log(`  Track #: ${fix.currentTrackNumber} → ${fix.newTrackNumber}`);
  console.log("");
}

if (fixes.length > 20) {
  console.log(`... and ${fixes.length - 20} more\n`);
}

// PHASE 1: Move ALL tracks in affected sessions to temp numbers
console.log("=== Phase 1: Move ALL tracks in affected sessions to temp numbers ===\n");

// Get all tracks in affected sessions (including ones not being fixed)
const affectedSessionIds = new Set(fixes.map(f => f.sessionId));

const allSessionTracks = await db.query.tracks.findMany();
const tracksInAffectedSessions = allSessionTracks.filter(t =>
  affectedSessionIds.has(t.sessionId)
);

console.log(`Moving ${tracksInAffectedSessions.length} tracks from ${affectedSessionIds.size} sessions to temp numbers...\n`);

for (const track of tracksInAffectedSessions) {
  const tempNumber = -(track.id + 10000000);
  await db.update(tracks)
    .set({ trackNumber: tempNumber })
    .where(eq(tracks.id, track.id));
}

console.log(`✅ Moved all tracks to temp numbers\n`);

// PHASE 2: Apply fixes
console.log("=== Phase 2: Apply correct track numbers ===\n");

let updatedCount = 0;

for (const fix of fixes) {
  try {
    await db.update(tracks)
      .set({ trackNumber: fix.newTrackNumber })
      .where(eq(tracks.id, fix.id));

    updatedCount++;
  } catch (error: any) {
    console.error(`Failed to update track ${fix.id}: ${error.message}`);
  }
}

console.log(`✅ Updated ${updatedCount} tracks\n`);

// PHASE 3: Restore other tracks back to original numbers
console.log("=== Phase 3: Restore non-fixed tracks to original numbers ===\n");

const tracksToRestore = tracksInAffectedSessions.filter(t =>
  !fixes.some(f => f.id === t.id)
);

console.log(`Restoring ${tracksToRestore.length} tracks to original numbers...\n`);

let restoredCount = 0;
for (const track of tracksToRestore) {
  // Only restore if it was positive originally
  if (track.trackNumber > 0) {
    try {
      await db.update(tracks)
        .set({ trackNumber: track.trackNumber })
        .where(eq(tracks.id, track.id));
      restoredCount++;
    } catch (error: any) {
      console.error(`Failed to restore track ${track.id}: ${error.message}`);
    }
  }
}

console.log(`✅ Restored ${restoredCount} tracks\n`);

console.log("\n=== Summary ===");
console.log(`Tracks fixed: ${updatedCount}`);
console.log(`Tracks restored: ${restoredCount}`);
console.log("Practice tracks now use normal track numbers from filenames");
console.log("No more negative track numbers - they sort normally with other tracks");
