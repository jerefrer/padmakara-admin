/**
 * Remove TRAD from speaker field - it's a translation indicator, not a speaker
 *
 * TRAD should be reflected in isTranslation flag, not in the speaker field
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";

console.log("\n=== Remove TRAD from Speaker Field ===\n");

// Find all tracks with speaker = "TRAD"
const tradTracks = await db.query.tracks.findMany({
  where: eq(tracks.speaker, "TRAD"),
  with: {
    session: {
      with: {
        event: true,
      },
    },
  },
});

console.log(`Found ${tradTracks.length} tracks with speaker="TRAD"\n`);

if (tradTracks.length === 0) {
  console.log("✅ No tracks to clean up\n");
  process.exit(0);
}

// Show preview
console.log("Preview of tracks to update (first 20):\n");
for (const track of tradTracks.slice(0, 20)) {
  console.log(`[${track.id}] ${track.session?.event?.eventCode || "unknown"} - Session ${track.session?.sessionNumber || "?"}`);
  console.log(`  File: ${track.originalFilename}`);
  console.log(`  Current: speaker="TRAD", isTranslation=${track.isTranslation}`);
  console.log(`  Will set: speaker=null, keep isTranslation=${track.isTranslation}`);
  console.log("");
}

if (tradTracks.length > 20) {
  console.log(`... and ${tradTracks.length - 20} more\n`);
}

// Apply fixes
console.log("=== Removing TRAD from Speaker Field ===\n");

let updatedCount = 0;

for (const track of tradTracks) {
  try {
    await db.update(tracks)
      .set({ speaker: null })
      .where(eq(tracks.id, track.id));

    updatedCount++;
  } catch (error: any) {
    console.error(`Failed to update track ${track.id}: ${error.message}`);
  }
}

console.log(`✅ Updated ${updatedCount} tracks - removed TRAD from speaker field\n`);

// Verify isTranslation status
const tradTracksWithoutTranslationFlag = tradTracks.filter(t => !t.isTranslation);
if (tradTracksWithoutTranslationFlag.length > 0) {
  console.log(`⚠️  Warning: ${tradTracksWithoutTranslationFlag.length} tracks had speaker="TRAD" but isTranslation=false`);
  console.log("   These tracks may need their isTranslation flag reviewed.\n");
}
