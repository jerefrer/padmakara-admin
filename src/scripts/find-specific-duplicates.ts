/**
 * Find specific duplicate tracks mentioned by user
 */

import { db } from "../db/index.ts";
import { events, sessions, tracks } from "../db/schema/retreats.ts";
import { eq, like, and } from "drizzle-orm";

const eventCode = "20191030_31-JKR-PWR-TRR-PP1-HSA";

console.log(`\n=== Finding Specific Duplicate Tracks ===\n`);

// Find all tracks with "refuge" in the filename for this event
const event = await db.query.events.findFirst({
  where: eq(events.eventCode, eventCode),
  with: {
    sessions: {
      with: { tracks: true },
      orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
    },
  },
});

if (!event) {
  console.log(`Event ${eventCode} not found!`);
  process.exit(1);
}

console.log(`Event: ${event.eventCode}`);
console.log(`Sessions: ${event.sessions?.length || 0}\n`);

// Collect all tracks and look for the pattern
for (const session of event.sessions || []) {
  console.log(`Session ${session.sessionNumber}:`);

  // Find tracks with "refuge" or "refugio" in filename
  const refugeTracks = session.tracks.filter(t =>
    t.originalFilename?.toLowerCase().includes('refuge') ||
    t.originalFilename?.toLowerCase().includes('refugio')
  );

  if (refugeTracks.length > 0) {
    console.log(`\nFound ${refugeTracks.length} refuge-related tracks:\n`);

    // Group by track number to find duplicates
    const byTrackNum = new Map<number, any[]>();
    for (const t of refugeTracks) {
      if (!byTrackNum.has(t.trackNumber)) {
        byTrackNum.set(t.trackNumber, []);
      }
      byTrackNum.get(t.trackNumber)!.push(t);
    }

    for (const [trackNum, tracks] of byTrackNum.entries()) {
      console.log(`Track ${trackNum}:`);
      for (const t of tracks) {
        console.log(`  [ID ${t.id}] ${t.speaker || "NO SPEAKER"} | ${t.language} | isTranslation: ${t.isTranslation}`);
        console.log(`    File: ${t.originalFilename}`);
      }

      if (tracks.length > 1) {
        // Check if any are duplicates (same language, different speaker)
        const langGroups = new Map<string, any[]>();
        for (const t of tracks) {
          if (!langGroups.has(t.language)) {
            langGroups.set(t.language, []);
          }
          langGroups.get(t.language)!.push(t);
        }

        for (const [lang, langTracks] of langGroups.entries()) {
          if (langTracks.length > 1) {
            console.log(`  ⚠️  DUPLICATE: ${langTracks.length} ${lang} versions of track ${trackNum}!`);

            // Show the differences
            for (let i = 0; i < langTracks.length; i++) {
              for (let j = i + 1; j < langTracks.length; j++) {
                const t1 = langTracks[i];
                const t2 = langTracks[j];
                console.log(`    Comparing IDs ${t1.id} vs ${t2.id}:`);
                console.log(`      Speaker: "${t1.speaker}" vs "${t2.speaker}"`);
                console.log(`      IsTranslation: ${t1.isTranslation} vs ${t2.isTranslation}`);
                console.log(`      Filename: "${t1.originalFilename}" vs "${t2.originalFilename}"`);
                console.log(`      File size: ${t1.fileSizeBytes} vs ${t2.fileSizeBytes}`);
              }
            }
          }
        }
      }
      console.log("");
    }
  }
}

// Now let's check ALL tracks in this event to understand the full picture
console.log("\n=== Full Track Analysis ===\n");

let totalTracks = 0;
let totalDuplicates = 0;

for (const session of event.sessions || []) {
  const byTrackNum = new Map<number, Map<string, any[]>>();

  for (const t of session.tracks) {
    totalTracks++;
    if (!byTrackNum.has(t.trackNumber)) {
      byTrackNum.set(t.trackNumber, new Map());
    }
    const langMap = byTrackNum.get(t.trackNumber)!;
    if (!langMap.has(t.language)) {
      langMap.set(t.language, []);
    }
    langMap.get(t.language)!.push(t);
  }

  // Find duplicates
  for (const [trackNum, langMap] of byTrackNum.entries()) {
    for (const [lang, langTracks] of langMap.entries()) {
      if (langTracks.length > 1) {
        totalDuplicates++;
        console.log(`Session ${session.sessionNumber}, Track ${trackNum}, Lang ${lang}: ${langTracks.length} duplicates`);
        for (const t of langTracks) {
          console.log(`  [${t.id}] ${t.speaker || "NO SPEAKER"} - ${t.originalFilename}`);
        }
      }
    }
  }
}

console.log(`\nTotal tracks: ${totalTracks}`);
console.log(`Duplicate groups found: ${totalDuplicates}`);
