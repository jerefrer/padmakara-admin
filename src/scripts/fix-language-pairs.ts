import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";

const DRY_RUN = !process.argv.includes("--execute");
if (DRY_RUN) console.log("=== DRY RUN (pass --execute to apply) ===\n");

function extractNormalizedPrefix(filename: string | null): number | null {
  if (!filename) return null;
  const match = filename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

const allSessions = await db.query.sessions.findMany({
  with: { tracks: { orderBy: (t: any, { asc }: any) => [asc(t.id)] } },
});

let totalSessionsFixed = 0;
let totalTracksFixed = 0;

for (const session of allSessions) {
  if (session.tracks.length === 0) continue;

  // Build map of EN originals by normalized prefix
  const enOriginalsByPrefix = new Map<number, any>();
  for (const track of session.tracks) {
    if (track.language === "en" && !track.isTranslation) {
      const prefix = extractNormalizedPrefix(track.originalFilename);
      if (prefix !== null) {
        enOriginalsByPrefix.set(prefix, track);
      }
    }
  }

  // Track which PT translations have already been paired
  const pairedPtPrefixes = new Set<number>();

  // Calculate new track numbers
  const newTrackNumbers = new Map<number, number>(); // trackId -> new track number
  let nextTrackNumber = 1;

  for (const track of session.tracks) {
    if (track.language === "pt" && track.isTranslation) {
      // PT translation - find its EN original by normalized prefix
      const prefix = extractNormalizedPrefix(track.originalFilename);
      const enOriginal = prefix !== null ? enOriginalsByPrefix.get(prefix) : null;

      // Only pair if we haven't already paired another PT track with this prefix
      if (enOriginal && newTrackNumbers.has(enOriginal.id) && prefix !== null && !pairedPtPrefixes.has(prefix)) {
        // Use same number as the EN original
        newTrackNumbers.set(track.id, newTrackNumbers.get(enOriginal.id)!);
        pairedPtPrefixes.add(prefix);
      } else {
        // No matching EN original found, or already paired - assign sequential number
        newTrackNumbers.set(track.id, nextTrackNumber++);
      }
    } else {
      // EN original or other tracks - assign sequential number
      newTrackNumbers.set(track.id, nextTrackNumber++);
    }
  }

  // Check if any changes needed
  const needsChange = session.tracks.some((t) => t.trackNumber !== newTrackNumbers.get(t.id));

  if (needsChange) {
    const oldNums = session.tracks.slice(0, 20).map((t) => t.trackNumber);
    const newNums = session.tracks.slice(0, 20).map((t) => newTrackNumbers.get(t.id));

    console.log(`Session ${session.id}: Fixing ${session.tracks.length} tracks`);
    console.log(`  Old: [${oldNums.join(", ")}...]`);
    console.log(`  New: [${newNums.join(", ")}...]`);

    if (!DRY_RUN) {
      // Two-phase update
      const TEMP_OFFSET = 100000;

      // Phase 1: Add offset
      for (const track of session.tracks) {
        await db
          .update(tracks)
          .set({ trackNumber: track.trackNumber + TEMP_OFFSET })
          .where(eq(tracks.id, track.id));
      }

      // Phase 2: Set final numbers
      for (const track of session.tracks) {
        const newNum = newTrackNumbers.get(track.id)!;
        await db.update(tracks).set({ trackNumber: newNum }).where(eq(tracks.id, track.id));
        totalTracksFixed++;
      }
    }

    totalSessionsFixed++;
  }
}

console.log(`\nSummary:`);
console.log(`  Sessions fixed: ${totalSessionsFixed}`);
if (!DRY_RUN) console.log(`  Tracks renumbered: ${totalTracksFixed}`);

if (DRY_RUN) console.log("\n=== DRY RUN — no changes made ===");
process.exit(0);
