/**
 * Data migration: Split Bodhisattva events 594 and 581 from single sessions
 * into proper morning/afternoon sessions per day.
 *
 * These events have all tracks in one session but should be split into
 * 14 sessions (7 days × 2 sessions/day: morning KPS, afternoon WF).
 *
 * Session boundaries are derived from:
 * - Event 594: TRAD filenames contain date + Manha/Tarde (e.g. "001-037 [TRAD] 6_10 - Manha.mp3")
 * - Event 581: Opening Prayers / Dedication patterns + KPS/WF speaker alternation
 *
 * TRAD tracks with high IDs (10044xxx, 10046xxx) are mapped to sessions by
 * extracting the original track number from their filenames.
 *
 * Usage: bun run src/scripts/migrate-split-bodhisattva.ts [--dry-run]
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";

const dryRun = process.argv.includes("--dry-run");

interface SessionDef {
  trackStart: number;
  trackEnd: number;
  date: string; // ISO date
  timePeriod: "morning" | "afternoon";
  title: string;
}

// Event 594: The Ninth Chapter of the Way of the Bodhisattva - Part 3 of 3
// Dates: Oct 6-12, 2019. Boundaries from TRAD filenames.
const EVENT_594_SESSIONS: SessionDef[] = [
  { trackStart: 1, trackEnd: 37, date: "2019-10-06", timePeriod: "morning", title: "October 6 - Morning" },
  { trackStart: 38, trackEnd: 49, date: "2019-10-06", timePeriod: "afternoon", title: "October 6 - Afternoon" },
  { trackStart: 50, trackEnd: 80, date: "2019-10-07", timePeriod: "morning", title: "October 7 - Morning" },
  { trackStart: 81, trackEnd: 93, date: "2019-10-07", timePeriod: "afternoon", title: "October 7 - Afternoon" },
  { trackStart: 94, trackEnd: 128, date: "2019-10-08", timePeriod: "morning", title: "October 8 - Morning" },
  { trackStart: 129, trackEnd: 143, date: "2019-10-08", timePeriod: "afternoon", title: "October 8 - Afternoon" },
  { trackStart: 144, trackEnd: 187, date: "2019-10-09", timePeriod: "morning", title: "October 9 - Morning" },
  { trackStart: 188, trackEnd: 201, date: "2019-10-09", timePeriod: "afternoon", title: "October 9 - Afternoon" },
  { trackStart: 202, trackEnd: 226, date: "2019-10-10", timePeriod: "morning", title: "October 10 - Morning" },
  { trackStart: 227, trackEnd: 237, date: "2019-10-10", timePeriod: "afternoon", title: "October 10 - Afternoon" },
  { trackStart: 238, trackEnd: 271, date: "2019-10-11", timePeriod: "morning", title: "October 11 - Morning" },
  { trackStart: 272, trackEnd: 284, date: "2019-10-11", timePeriod: "afternoon", title: "October 11 - Afternoon" },
  { trackStart: 285, trackEnd: 341, date: "2019-10-12", timePeriod: "morning", title: "October 12 - Morning" },
  { trackStart: 342, trackEnd: 352, date: "2019-10-12", timePeriod: "afternoon", title: "October 12 - Afternoon" },
];

// Event 581: The Ninth Chapter of the Way of the Bodhisattva - Part 2 of 3
// Dates: Aug 9-15, 2018. Boundaries from Opening Prayers/Dedication + KPS/WF alternation.
const EVENT_581_SESSIONS: SessionDef[] = [
  { trackStart: 1, trackEnd: 21, date: "2018-08-09", timePeriod: "morning", title: "August 9 - Morning" },
  { trackStart: 22, trackEnd: 36, date: "2018-08-09", timePeriod: "afternoon", title: "August 9 - Afternoon" },
  { trackStart: 37, trackEnd: 51, date: "2018-08-10", timePeriod: "morning", title: "August 10 - Morning" },
  { trackStart: 52, trackEnd: 66, date: "2018-08-10", timePeriod: "afternoon", title: "August 10 - Afternoon" },
  { trackStart: 67, trackEnd: 84, date: "2018-08-11", timePeriod: "morning", title: "August 11 - Morning" },
  { trackStart: 85, trackEnd: 99, date: "2018-08-11", timePeriod: "afternoon", title: "August 11 - Afternoon" },
  { trackStart: 100, trackEnd: 124, date: "2018-08-12", timePeriod: "morning", title: "August 12 - Morning" },
  { trackStart: 125, trackEnd: 138, date: "2018-08-12", timePeriod: "afternoon", title: "August 12 - Afternoon" },
  { trackStart: 139, trackEnd: 165, date: "2018-08-13", timePeriod: "morning", title: "August 13 - Morning" },
  { trackStart: 166, trackEnd: 181, date: "2018-08-13", timePeriod: "afternoon", title: "August 13 - Afternoon" },
  { trackStart: 182, trackEnd: 206, date: "2018-08-14", timePeriod: "morning", title: "August 14 - Morning" },
  { trackStart: 207, trackEnd: 221, date: "2018-08-14", timePeriod: "afternoon", title: "August 14 - Afternoon" },
  { trackStart: 222, trackEnd: 240, date: "2018-08-15", timePeriod: "morning", title: "August 15 - Morning" },
  { trackStart: 241, trackEnd: 251, date: "2018-08-15", timePeriod: "afternoon", title: "August 15 - Afternoon" },
];

/**
 * Extract the "original track number" from a TRAD filename.
 * Patterns:
 * - "002_TRAD Introducao..." → 2
 * - "001-037 [TRAD] 6_10 - Manha.mp3" → 1 (use first number)
 * - "093 [TRAD] - 7_10 - Questao extra.mp3" → 93
 */
function extractOriginalTrackNumber(filename: string): number | null {
  // Pattern: "NNN_TRAD" or "NNN [TRAD]" or "NNN-NNN [TRAD]"
  const match = filename.match(/^(\d+)[_\s\-\[]/);
  if (match) return parseInt(match[1]!, 10);
  return null;
}

function findSessionForTrack(trackNum: number, sessionDefs: SessionDef[]): number {
  for (let i = 0; i < sessionDefs.length; i++) {
    if (trackNum >= sessionDefs[i]!.trackStart && trackNum <= sessionDefs[i]!.trackEnd) {
      return i;
    }
  }
  return -1;
}

async function processEvent(eventId: number, sessionDefs: SessionDef[]) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing Event ${eventId}`);
  console.log(`${"=".repeat(60)}`);

  // Get existing sessions for this event
  const existingSessions = await db.select().from(sessions).where(eq(sessions.eventId, eventId));

  if (existingSessions.length !== 1) {
    console.log(`  SKIP: Event has ${existingSessions.length} sessions (expected 1)`);
    return { sessionsCreated: 0, tracksMoved: 0 };
  }

  const originalSession = existingSessions[0]!;
  console.log(`  Original session: ${originalSession.id} "${originalSession.titleEn}" (num=${originalSession.sessionNumber})`);

  // Get all tracks
  const allTracks = await db.select({
    id: tracks.id,
    trackNumber: tracks.trackNumber,
    title: tracks.title,
    originalFilename: tracks.originalFilename,
    isTranslation: tracks.isTranslation,
    speaker: tracks.speaker,
  }).from(tracks).where(eq(tracks.sessionId, originalSession.id));

  console.log(`  Total tracks: ${allTracks.length}`);

  // Map each track to a session index
  const trackToSession = new Map<number, number>(); // track.id → session index
  let unmapped = 0;

  for (const track of allTracks) {
    let origTrackNum = track.trackNumber;

    // For high-ID tracks (TRAD files added later), parse original track number from filename
    if (origTrackNum > 10000 && track.originalFilename) {
      const parsed = extractOriginalTrackNumber(track.originalFilename);
      if (parsed !== null) {
        origTrackNum = parsed;
      }
    }

    const sessionIdx = findSessionForTrack(origTrackNum, sessionDefs);
    if (sessionIdx >= 0) {
      trackToSession.set(track.id, sessionIdx);
    } else {
      console.log(`  WARNING: Track ${track.id} (num=${track.trackNumber}, "${track.title}") could not be mapped (origNum=${origTrackNum})`);
      unmapped++;
    }
  }

  if (unmapped > 0) {
    console.log(`  ${unmapped} tracks could not be mapped to sessions`);
  }

  // Count tracks per session
  const sessionTrackCounts = new Map<number, number>();
  for (const [, sessIdx] of trackToSession) {
    sessionTrackCounts.set(sessIdx, (sessionTrackCounts.get(sessIdx) ?? 0) + 1);
  }

  // Print plan
  for (let i = 0; i < sessionDefs.length; i++) {
    const def = sessionDefs[i]!;
    const count = sessionTrackCounts.get(i) ?? 0;
    const action = i === 0 ? "REUSE" : "CREATE";
    console.log(`  Session ${i + 1}: "${def.title}" (${def.date} ${def.timePeriod}) - ${count} tracks [${action}]`);
  }

  if (dryRun) {
    console.log(`  DRY RUN: No changes made`);
    return { sessionsCreated: sessionDefs.length - 1, tracksMoved: allTracks.length };
  }

  // Create sessions and reassign tracks
  const sessionIdMap = new Map<number, number>(); // session index → session ID

  for (let i = 0; i < sessionDefs.length; i++) {
    const def = sessionDefs[i]!;

    if (i === 0) {
      // Reuse the original session
      await db.update(sessions).set({
        titleEn: def.title,
        titlePt: def.title,
        sessionDate: def.date,
        timePeriod: def.timePeriod,
        sessionNumber: 1,
        updatedAt: new Date(),
      }).where(eq(sessions.id, originalSession.id));
      sessionIdMap.set(0, originalSession.id);
      console.log(`  Updated session ${originalSession.id} → "${def.title}"`);
    } else {
      const [newSess] = await db.insert(sessions).values({
        eventId,
        titleEn: def.title,
        titlePt: def.title,
        sessionDate: def.date,
        timePeriod: def.timePeriod,
        sessionNumber: i + 1,
      }).returning({ id: sessions.id });
      sessionIdMap.set(i, newSess!.id);
      console.log(`  Created session ${newSess!.id} → "${def.title}"`);
    }
  }

  // Move tracks to their sessions
  let tracksMoved = 0;
  for (const [trackId, sessIdx] of trackToSession) {
    const targetSessionId = sessionIdMap.get(sessIdx);
    if (!targetSessionId) continue;

    // Skip tracks already in correct session (session 0 = original session)
    if (sessIdx === 0 && targetSessionId === originalSession.id) continue;

    await db.update(tracks).set({
      sessionId: targetSessionId,
      updatedAt: new Date(),
    }).where(eq(tracks.id, trackId));
    tracksMoved++;
  }

  console.log(`  Moved ${tracksMoved} tracks to new sessions`);
  return { sessionsCreated: sessionDefs.length - 1, tracksMoved };
}

async function main() {
  console.log("=== Migrate: Split Bodhisattva Events ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);

  const result594 = await processEvent(594, EVENT_594_SESSIONS);
  const result581 = await processEvent(581, EVENT_581_SESSIONS);

  console.log(`\n${"=".repeat(60)}`);
  console.log("Summary:");
  console.log(`  Event 594: ${result594.sessionsCreated} sessions created, ${result594.tracksMoved} tracks moved`);
  console.log(`  Event 581: ${result581.sessionsCreated} sessions created, ${result581.tracksMoved} tracks moved`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
