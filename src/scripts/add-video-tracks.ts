/**
 * Add missing video tracks to existing events.
 *
 * Reads s3-inventory.json and adds video tracks that weren't imported during Phase 4
 * (because the original seed script only looked for audio files).
 *
 * Usage:
 *   bun run src/scripts/add-video-tracks.ts                      # all events
 *   bun run src/scripts/add-video-tracks.ts --dry-run             # preview only
 *   bun run src/scripts/add-video-tracks.ts --events CODE1,CODE2  # specific events
 */

import { readFileSync } from "fs";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { parseTrackFilename } from "../services/track-parser.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const eventFilter = process.argv.find((arg) => arg.startsWith("--events="))?.split("=")[1]?.split(",");

console.log("=== Add Missing Video Tracks ===");
console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
if (eventFilter) console.log(`Filter: ${eventFilter.join(", ")}`);

// Load s3-inventory.json
const inventoryPath = "/Users/jeremy/Documents/Programming/padmakara-backend-frontend/scripts/migration/s3-inventory.json";
const inventoryData = JSON.parse(readFileSync(inventoryPath, "utf-8"));
const inventory = inventoryData.events || [];

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv"]);

function isVideoFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.has(ext);
}

let totalEventsProcessed = 0;
let totalTracksAdded = 0;

console.log(`\nProcessing ${inventory.length} events from inventory...`);

for (const invEvent of inventory) {
  const code = invEvent.canonicalCode;

  // Apply event filter if specified
  if (eventFilter && !eventFilter.includes(code)) continue;

  console.log(`\nChecking ${code}...`);

  // Find event in database
  const event = await db.query.events.findFirst({
    where: (e, { eq }) => eq(e.eventCode, code),
    with: {
      sessions: {
        with: {
          tracks: true,
        },
      },
    },
  });

  if (!event) {
    console.log(`  [SKIP] ${code}: not found in database`);
    continue;
  }

  console.log(`  Found in database: ${event.titleEn} (${event.sessions.length} sessions)`);

  // Extract video files from inventory
  const videoFiles: Array<{ filename: string; size: number; s3Key: string }> = [];

  for (const file of invEvent.files || []) {
    // Check zipContents
    if (file.zipContents) {
      for (const entry of file.zipContents) {
        const basename = entry.name.split("/").pop() ?? "";
        if (isVideoFile(basename)) {
          videoFiles.push({
            filename: basename,
            size: entry.uncompressedSize,
            s3Key: `${file.s3Key}/${basename}`, // Construct S3 key
          });
        }
      }
    }
    // Check loose files
    else if (isVideoFile(file.relativePath.split("/").pop() ?? "")) {
      videoFiles.push({
        filename: file.relativePath.split("/").pop() ?? "",
        size: file.size,
        s3Key: file.s3Key,
      });
    }
  }

  console.log(`  Found ${videoFiles.length} video files in inventory`);

  if (videoFiles.length === 0) {
    continue; // No video files for this event
  }

  // Parse video files into tracks
  const parsedTracks = videoFiles.map((vf) => parseTrackFilename(vf.filename, vf.size));

  console.log(`  Parsed ${parsedTracks.length} tracks from video files`);
  for (const pt of parsedTracks) {
    console.log(`    - ${pt.originalFilename}: session ${pt.sessionDate}|${pt.timePeriod}, track #${pt.trackNumber} [${pt.language}]`);
  }

  // Group by session (same logic as seed-content.ts)
  const sessionGroups = new Map<string, typeof parsedTracks>();

  for (const pt of parsedTracks) {
    const key = `${pt.sessionDate ?? "unknown"}|${pt.timePeriod ?? "unknown"}`;
    if (!sessionGroups.has(key)) {
      sessionGroups.set(key, []);
    }
    sessionGroups.get(key)!.push(pt);
  }

  console.log(`  Grouped into ${sessionGroups.size} session groups`);

  // Match to existing sessions and add tracks
  let tracksAddedForEvent = 0;

  for (const session of event.sessions) {
    const sessionKey = `${session.sessionDate ?? "unknown"}|${session.timePeriod ?? "unknown"}`;
    let videoTracksForSession = sessionGroups.get(sessionKey) || [];

    // If no session match and there's only one session, assume videos belong to it
    if (videoTracksForSession.length === 0 && event.sessions.length === 1 && parsedTracks.length > 0) {
      console.log(`  Note: No session match, but only 1 session exists - assigning all ${parsedTracks.length} video(s) to it`);
      videoTracksForSession = parsedTracks;
    }

    if (videoTracksForSession.length === 0) continue;

    // Find the max track number in this session
    const maxTrackNum = Math.max(0, ...session.tracks.map((t) => t.trackNumber));
    console.log(`  Session ${session.sessionNumber} has ${session.tracks.length} existing tracks, max trackNumber: ${maxTrackNum}`);

    let nextTrackNum = maxTrackNum + 1;

    for (const vt of videoTracksForSession) {
      // Check if this track already exists (by filename)
      const exists = session.tracks.some((t) => t.originalFilename === vt.originalFilename);

      if (exists) {
        console.log(`  [SKIP] ${code} session ${session.sessionNumber}: ${vt.originalFilename} already exists`);
        continue;
      }

      // Find corresponding video file to get S3 key
      const videoFile = videoFiles.find((vf) => vf.filename === vt.originalFilename);
      if (!videoFile) continue;

      // Assign track number if not already set
      const trackNumber = vt.trackNumber > 0 ? vt.trackNumber : nextTrackNum++;

      console.log(`  [ADD] ${code} session ${session.sessionNumber}: #${trackNumber} [${vt.language}] ${vt.originalFilename}`);

      if (!DRY_RUN) {
        await db.insert(tracks).values({
          sessionId: session.id,
          trackNumber: trackNumber,
          title: vt.title,
          speaker: vt.speaker,
          language: vt.language,
          isTranslation: vt.isTranslation,
          s3Key: videoFile.s3Key,
          durationSeconds: 0, // Unknown - would need video metadata
          fileSizeBytes: videoFile.size,
          originalFilename: vt.originalFilename,
        });
      }

      tracksAddedForEvent++;
      totalTracksAdded++;
    }
  }

  if (tracksAddedForEvent > 0) {
    console.log(`[PROCESSED] ${code}: ${tracksAddedForEvent} video tracks added`);
    totalEventsProcessed++;
  }
}

console.log("\n=== Summary ===");
console.log(`Events processed: ${totalEventsProcessed}`);
console.log(`Video tracks added: ${totalTracksAdded}`);
if (DRY_RUN) console.log("\n[DRY RUN] No changes made to database");
