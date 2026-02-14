/**
 * Data migration: Split single sessions into multiple sessions based on
 * date/time/part info extracted from track filenames.
 *
 * Some events were uploaded as a single session but the filenames contain
 * session info like "(8 April_AM_Part 1)" that should split into:
 *   - April 8 Morning Part 1
 *   - April 8 Morning Part 2
 *   - April 8 Afternoon
 *   - April 9 Morning Part 1
 *   - etc.
 *
 * This migration also re-parses track titles to strip session info.
 *
 * Usage: bun run src/scripts/migrate-split-sessions.ts [--dry-run]
 */

import { eq, sql, and } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { parseTrackFilename } from "../services/track-parser.ts";

const dryRun = process.argv.includes("--dry-run");

interface TrackRow {
  id: number;
  sessionId: number;
  title: string;
  trackNumber: number;
  originalFilename: string | null;
  isTranslation: boolean;
  speaker: string | null;
}

interface SessionGroup {
  date: string | null;
  timePeriod: string | null;
  partNumber: number | null;
  tracks: TrackRow[];
  parsedTracks: ReturnType<typeof parseTrackFilename>[];
}

/** Build a session title like "April 8 - Morning (Part 1)" */
function buildSessionTitle(
  date: string | null,
  timePeriod: string | null,
  partNumber: number | null,
): string {
  if (!date && !timePeriod) return "Session";
  let title = date ?? "";
  if (timePeriod) {
    const label = timePeriod === "morning" ? "Morning" : "Afternoon";
    title += title ? ` - ${label}` : label;
  }
  if (partNumber) {
    title += ` (Part ${partNumber})`;
  }
  return title;
}

const MONTH_TO_NUM: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

/** Convert "April 8" + year to ISO date "2024-04-08" */
function toIsoDate(parsedDate: string | null, year: number): string | null {
  if (!parsedDate) return null;
  const match = parsedDate.match(/^(\w+)\s+(\d+)$/);
  if (!match) return parsedDate; // Already ISO or unknown format
  const month = MONTH_TO_NUM[match[1]!.toLowerCase()];
  if (!month) return null;
  const day = match[2]!.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function main() {
  console.log("=== Migrate: Split Sessions by Date/Time/Part ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);

  // Find sessions that have tracks with parenthetical session info
  // and where ALL tracks are in a single session per event
  const allSessions = await db.select().from(sessions);

  // Group sessions by event
  const sessionsByEvent = new Map<number, typeof allSessions>();
  for (const sess of allSessions) {
    const arr = sessionsByEvent.get(sess.eventId) ?? [];
    arr.push(sess);
    sessionsByEvent.set(sess.eventId, arr);
  }

  let eventsProcessed = 0;
  let sessionsCreated = 0;
  let tracksMoved = 0;
  let titlesFixed = 0;

  for (const [eventId, eventSessions] of sessionsByEvent) {
    // Only process events with a single session (these are the ones that need splitting)
    if (eventSessions.length !== 1) continue;

    const sess = eventSessions[0]!;

    // Extract year from the existing session date (e.g. "2024-04-08" → 2024)
    const existingYear = sess.sessionDate
      ? parseInt(sess.sessionDate.slice(0, 4), 10)
      : new Date().getFullYear();

    // Get all tracks for this session
    const sessionTracks = await db
      .select({
        id: tracks.id,
        sessionId: tracks.sessionId,
        title: tracks.title,
        trackNumber: tracks.trackNumber,
        originalFilename: tracks.originalFilename,
        isTranslation: tracks.isTranslation,
        speaker: tracks.speaker,
      })
      .from(tracks)
      .where(eq(tracks.sessionId, sess.id));

    // Parse all filenames and check if any have session info
    const parsedList = sessionTracks.map((t) => ({
      track: t,
      parsed: t.originalFilename ? parseTrackFilename(t.originalFilename) : null,
    }));

    const withSessionInfo = parsedList.filter(
      (p) => p.parsed && (p.parsed.timePeriod !== null || p.parsed.partNumber !== null),
    );

    if (withSessionInfo.length === 0) continue;

    // Group tracks by (date, timePeriod, partNumber)
    const groups = new Map<string, SessionGroup>();

    for (const { track, parsed } of parsedList) {
      // For tracks with session info, use it. For TRAD tracks without, match by track number.
      let key: string;
      if (parsed && parsed.timePeriod !== null) {
        key = `${parsed.date ?? "unknown"}|${parsed.timePeriod}|${parsed.partNumber ?? ""}`;
      } else if (track.isTranslation) {
        // Try to find matching original by track number
        const matchingOriginal = withSessionInfo.find(
          (p) => p.track.trackNumber === track.trackNumber && !p.track.isTranslation,
        );
        if (matchingOriginal?.parsed) {
          key = `${matchingOriginal.parsed.date ?? "unknown"}|${matchingOriginal.parsed.timePeriod}|${matchingOriginal.parsed.partNumber ?? ""}`;
        } else {
          key = "unknown|unknown|";
        }
      } else {
        key = "unknown|unknown|";
      }

      const group = groups.get(key) ?? {
        date: parsed?.date ?? null,
        timePeriod: parsed?.timePeriod ?? null,
        partNumber: parsed?.partNumber ?? null,
        tracks: [],
        parsedTracks: [],
      };
      group.tracks.push(track);
      if (parsed) group.parsedTracks.push(parsed);
      // Use parsed info from a track that has it to set group metadata
      if (parsed?.timePeriod && !group.timePeriod) {
        group.date = parsed.date;
        group.timePeriod = parsed.timePeriod;
        group.partNumber = parsed.partNumber;
      }
      groups.set(key, group);
    }

    // If only one group, no splitting needed (but may still fix titles)
    if (groups.size <= 1) {
      // Still fix titles if they contain session info
      for (const { track, parsed } of parsedList) {
        if (parsed && parsed.title !== track.title) {
          if (!dryRun) {
            await db
              .update(tracks)
              .set({ title: parsed.title, updatedAt: new Date() })
              .where(eq(tracks.id, track.id));
          }
          titlesFixed++;
        }
      }
      continue;
    }

    eventsProcessed++;
    console.log(`\nEvent ${eventId} (session ${sess.id}): splitting into ${groups.size} sessions`);

    // Sort groups chronologically
    const periodOrder: Record<string, number> = { morning: 0, afternoon: 1, evening: 2, unknown: 3 };
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      const [dateA, periodA, partA] = a.split("|");
      const [dateB, periodB, partB] = b.split("|");
      if (dateA !== dateB) return dateA!.localeCompare(dateB!);
      const pA = periodOrder[periodA!] ?? 3;
      const pB = periodOrder[periodB!] ?? 3;
      if (pA !== pB) return pA - pB;
      return (partA ?? "").localeCompare(partB ?? "");
    });

    let sessionNumber = 1;

    for (const key of sortedKeys) {
      const group = groups.get(key)!;
      const title = buildSessionTitle(group.date, group.timePeriod, group.partNumber);

      console.log(
        `  Session ${sessionNumber}: "${title}" (${group.tracks.length} tracks, ` +
          `date=${group.date}, time=${group.timePeriod}, part=${group.partNumber})`,
      );

      if (sessionNumber === 1) {
        // Reuse the existing session - update its metadata
        if (!dryRun) {
          await db
            .update(sessions)
            .set({
              titleEn: title,
              titlePt: title,
              sessionDate: toIsoDate(group.date, existingYear),
              timePeriod: group.timePeriod ?? "morning",
              partNumber: group.partNumber,
              sessionNumber: 1,
              updatedAt: new Date(),
            })
            .where(eq(sessions.id, sess.id));
        }

        // Fix titles and speaker for tracks in this session
        for (const track of group.tracks) {
          const parsed = parsedList.find((p) => p.track.id === track.id)?.parsed;
          if (!parsed) continue;
          const updates: Record<string, unknown> = {};
          if (parsed.title !== track.title) {
            updates.title = parsed.title;
            titlesFixed++;
          }
          if (parsed.speaker && parsed.speaker !== track.speaker) {
            updates.speaker = parsed.speaker;
          }
          if (Object.keys(updates).length > 0) {
            updates.updatedAt = new Date();
            if (!dryRun) {
              await db.update(tracks).set(updates).where(eq(tracks.id, track.id));
            }
          }
        }
      } else {
        // Create a new session
        let newSessionId: number | null = null;
        if (!dryRun) {
          const [newSess] = await db
            .insert(sessions)
            .values({
              eventId,
              titleEn: title,
              titlePt: title,
              sessionDate: toIsoDate(group.date, existingYear),
              timePeriod: group.timePeriod ?? "morning",
              partNumber: group.partNumber,
              sessionNumber,
            })
            .returning({ id: sessions.id });
          newSessionId = newSess!.id;
        }

        sessionsCreated++;

        // Move tracks to new session and fix titles
        for (const track of group.tracks) {
          const parsed = parsedList.find((p) => p.track.id === track.id)?.parsed;
          const updates: Record<string, unknown> = {
            sessionId: newSessionId ?? track.sessionId,
            updatedAt: new Date(),
          };
          if (parsed && parsed.title !== track.title) {
            updates.title = parsed.title;
            titlesFixed++;
          }
          if (parsed?.speaker && parsed.speaker !== track.speaker) {
            updates.speaker = parsed.speaker;
          }
          if (!dryRun) {
            await db.update(tracks).set(updates).where(eq(tracks.id, track.id));
          }
          tracksMoved++;
        }
      }

      sessionNumber++;
    }
  }

  console.log(`\nResults:`);
  console.log(`  Events processed: ${eventsProcessed}`);
  console.log(`  Sessions created: ${sessionsCreated}`);
  console.log(`  Tracks moved:     ${tracksMoved}`);
  console.log(`  Titles fixed:     ${titlesFixed}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
