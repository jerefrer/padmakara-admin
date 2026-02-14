/**
 * Split AM/PM tracks into separate morning/afternoon sessions
 */

import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

console.log("=== Split AM/PM Sessions ===");
const mode = DRY_RUN ? "DRY RUN" : "LIVE";
console.log("Mode:", mode);
console.log("");

// Find all events that have tracks with AM/PM patterns
const allEvents = await db.query.events.findMany({
  with: {
    sessions: {
      with: {
        tracks: true,
      },
    },
  },
});

// Filter to only events that have AM/PM tracks
const eventList = allEvents
  .filter(e =>
    e.sessions.some(s =>
      s.tracks.some(t => {
        const filename = t.originalFilename || "";
        return filename.match(/_(AM|PM)/i);
      })
    )
  )
  .map(e => ({ event_id: e.id, event_code: e.eventCode }));

console.log("Found events to process:", eventList.length);
console.log("");

let totalSessionsCreated = 0;
let totalTracksUpdated = 0;
let totalSessionsDeleted = 0;

for (const eventData of eventList) {
  console.log("");
  console.log(eventData.event_code);

  // Get all sessions and tracks for this event
  const event = await db.query.events.findFirst({
    where: (e, { eq }) => eq(e.id, eventData.event_id),
    with: {
      sessions: {
        with: {
          tracks: {
            orderBy: (t, { asc }) => [asc(t.trackNumber)],
          },
        },
        orderBy: (s, { asc }) => [asc(s.sessionNumber)],
      },
    },
  });

  if (!event) continue;

  // Find max session number for this event
  const maxSessionNumber = Math.max(...event.sessions.map(s => s.sessionNumber), 0);
  let nextSessionNumber = maxSessionNumber + 1;

  console.log("  Current sessions:", event.sessions.length, "| max session #:", maxSessionNumber);

  // Process each session
  for (const session of event.sessions) {
    const amPmTracks = session.tracks.filter(t => {
      const filename = t.originalFilename || "";
      return filename.match(/_(AM|PM)/i);
    });

    if (amPmTracks.length === 0) {
      // No AM/PM tracks in this session, skip
      continue;
    }

    console.log("");
    console.log("  Session", session.sessionNumber + ":", amPmTracks.length, "AM/PM tracks");

    // Group tracks by date + period
    const trackGroups = new Map<string, typeof session.tracks>();

    for (const track of session.tracks) {
      const filename = track.originalFilename || "";
      const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
      const periodMatch = filename.match(/_(AM|PM)/i);

      if (!dateMatch || !periodMatch) {
        // No AM/PM pattern, keep in original session
        const key = "default";
        if (!trackGroups.has(key)) trackGroups.set(key, []);
        trackGroups.get(key)!.push(track);
        continue;
      }

      const date = dateMatch[1];
      const period = periodMatch[1].toUpperCase();
      const key = date + "_" + period;

      if (!trackGroups.has(key)) trackGroups.set(key, []);
      trackGroups.get(key)!.push(track);
    }

    console.log("  Track groups:", trackGroups.size);
    for (const [key, groupTracks] of trackGroups) {
      console.log("    -", key + ":", groupTracks.length, "tracks");
    }

    // Create new sessions and move tracks
    for (const [key, groupTracks] of trackGroups) {
      if (key === "default") {
        // Keep these tracks in original session
        continue;
      }

      const parts = key.split("_");
      const date = parts[0];
      const period = parts[1];
      const timePeriod = period === "AM" ? "morning" : "afternoon";

      if (!DRY_RUN) {
        // Create new session
        const [newSession] = await db.insert(sessions).values({
          eventId: event.id,
          sessionNumber: nextSessionNumber,
          sessionDate: date,
          timePeriod,
          titleEn: null,
          titlePt: null,
        }).returning();

        console.log("    ✓ Created session", nextSessionNumber, "(" + date, timePeriod + ")");

        // Update tracks to point to new session and remove AM/PM
        for (const track of groupTracks) {
          const cleanedTitle = track.title.replace(/\s*-?\s*\d{4}-\d{2}-\d{2}_(AM|PM)/gi, '');
          const cleanedFilename = (track.originalFilename || "").replace(/_(AM|PM)/gi, '');

          await db.update(tracks)
            .set({
              sessionId: newSession!.id,
              title: cleanedTitle,
              originalFilename: cleanedFilename,
            })
            .where(eq(tracks.id, track.id));
        }

        console.log("    ✓ Moved", groupTracks.length, "tracks");
        totalTracksUpdated += groupTracks.length;
        totalSessionsCreated++;
        nextSessionNumber++;
      } else {
        console.log("    [DRY RUN] Would create session", nextSessionNumber, "(" + date, timePeriod + ") with", groupTracks.length, "tracks");
        nextSessionNumber++;
      }
    }

    // If all tracks were moved, delete the original session
    const defaultTracks = trackGroups.get("default") || [];
    if (defaultTracks.length === 0 && trackGroups.size > 1) {
      if (!DRY_RUN) {
        await db.delete(sessions).where(eq(sessions.id, session.id));
        console.log("  ✓ Deleted empty session", session.sessionNumber);
        totalSessionsDeleted++;
      } else {
        console.log("  [DRY RUN] Would delete empty session", session.sessionNumber);
      }
    }
  }
}

console.log("");
console.log("=== Summary ===");
console.log("Sessions created:", totalSessionsCreated);
console.log("Sessions deleted:", totalSessionsDeleted);
console.log("Tracks updated:", totalTracksUpdated);
if (DRY_RUN) {
  console.log("");
  console.log("[DRY RUN] No changes made to database");
  console.log("Run without --dry-run to apply changes");
}
