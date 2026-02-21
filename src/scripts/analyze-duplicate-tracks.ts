/**
 * Analyze duplicate tracks across all events
 * Identifies tracks with same track number and language but different speakers
 */

import { db } from "../db/index.ts";
import { events, sessions, tracks } from "../db/schema/retreats.ts";
import { eq } from "drizzle-orm";

const eventCode = "20191030_31-JKR-PWR-TRR-PP1-HSA";

console.log(`\n=== Analyzing Duplicate Tracks ===\n`);

// Find the event
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

console.log(`Event: ${event.eventCode} - ${event.titleEn}`);
console.log(`Sessions: ${event.sessions?.length || 0}\n`);

// Analyze each session for duplicates
for (const session of event.sessions || []) {
  console.log(`\nSession ${session.sessionNumber}: ${session.titleEn}`);
  console.log(`Tracks: ${session.tracks.length}`);

  // Group tracks by track number and language
  const trackGroups = new Map<string, any[]>();

  for (const track of session.tracks) {
    const key = `${track.trackNumber}-${track.language}`;
    if (!trackGroups.has(key)) {
      trackGroups.set(key, []);
    }
    trackGroups.get(key)!.push(track);
  }

  // Find duplicates (same track number + language, different speakers/files)
  const duplicates: Array<{ key: string; tracks: any[] }> = [];
  for (const [key, groupTracks] of trackGroups.entries()) {
    if (groupTracks.length > 1) {
      duplicates.push({ key, tracks: groupTracks });
    }
  }

  if (duplicates.length > 0) {
    console.log(`\n⚠️  Found ${duplicates.length} duplicate track group(s):`);
    for (const dup of duplicates) {
      const [trackNum, lang] = dup.key.split("-");
      console.log(`\n  Track ${trackNum} (${lang}):`);
      for (const t of dup.tracks) {
        console.log(`    - [ID ${t.id}] ${t.speaker || "no speaker"} | ${t.originalFilename}`);
        console.log(`      isTranslation: ${t.isTranslation}`);
      }
    }
  } else {
    console.log("  ✓ No duplicates");
  }
}

// Now scan ALL events for similar patterns
console.log("\n\n=== Scanning ALL Events for Duplicate Patterns ===\n");

const allEvents = await db.query.events.findMany({
  with: {
    sessions: {
      with: { tracks: true },
      orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
    },
  },
});

const eventsWithDuplicates: Array<{ eventCode: string; sessionNumber: number; duplicateCount: number }> = [];

for (const evt of allEvents) {
  for (const session of evt.sessions || []) {
    const trackGroups = new Map<string, any[]>();

    for (const track of session.tracks) {
      const key = `${track.trackNumber}-${track.language}`;
      if (!trackGroups.has(key)) {
        trackGroups.set(key, []);
      }
      trackGroups.get(key)!.push(track);
    }

    let dupCount = 0;
    for (const [, groupTracks] of trackGroups.entries()) {
      if (groupTracks.length > 1) {
        dupCount++;
      }
    }

    if (dupCount > 0) {
      eventsWithDuplicates.push({
        eventCode: evt.eventCode,
        sessionNumber: session.sessionNumber,
        duplicateCount: dupCount,
      });
    }
  }
}

console.log(`Found ${eventsWithDuplicates.length} session(s) with duplicates across ${new Set(eventsWithDuplicates.map(e => e.eventCode)).size} event(s)\n`);

if (eventsWithDuplicates.length > 0) {
  console.log("Events with duplicate tracks:");
  const grouped = new Map<string, number[]>();
  for (const item of eventsWithDuplicates) {
    if (!grouped.has(item.eventCode)) {
      grouped.set(item.eventCode, []);
    }
    grouped.get(item.eventCode)!.push(item.sessionNumber);
  }

  for (const [code, sessionNumbers] of grouped.entries()) {
    console.log(`  ${code}: Sessions ${sessionNumbers.join(", ")}`);
  }
}
