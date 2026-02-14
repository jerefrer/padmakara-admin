/**
 * Fix s3Key values in tracks table to match actual S3 file paths.
 *
 * The seed script generated s3Keys with a different event code and an
 * extra `audio/` subdirectory that doesn't exist in the actual S3 bucket.
 * This script scans S3, matches files to DB tracks by file size + speaker +
 * event date prefix, and updates the s3Key to the correct path.
 *
 * Usage:
 *   bun run src/scripts/fix-s3-keys.ts              # fix all
 *   bun run src/scripts/fix-s3-keys.ts --dry-run    # inspect only
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { listObjects } from "../services/s3.ts";
import { eq, isNotNull } from "drizzle-orm";

const isDryRun = process.argv.includes("--dry-run");

/** Extract speaker code from an S3 filename like "001 - JKR - Title.mp3" */
function extractSpeaker(filename: string): string | null {
  const match = filename.match(/^\d+\s*-?\s*(\w+)\s*-/);
  return match ? match[1].toUpperCase() : null;
}

/** Extract event date prefix from S3 key: "events/20250417_18-JKR-RET/..." → "20250417" */
function extractDatePrefix(s3Key: string): string | null {
  const match = s3Key.match(/events\/(\d{8})/);
  return match ? match[1] : null;
}

async function main() {
  console.log("=== Fix S3 Keys ===");
  if (isDryRun) console.log("(Dry run — no DB updates)\n");

  // 1. List all audio files in S3
  const s3Files = await listObjects("events/");
  const audioFiles = s3Files.filter(
    (f) => f.key.endsWith(".mp3") || f.key.endsWith(".m4a"),
  );
  console.log(`Found ${audioFiles.length} audio files in S3\n`);

  if (audioFiles.length === 0) {
    console.log("No audio files found in S3. Nothing to fix.");
    process.exit(0);
  }

  // 2. Load all DB tracks with s3Key
  const dbTracks = await db
    .select({
      id: tracks.id,
      s3Key: tracks.s3Key,
      title: tracks.title,
      fileSizeBytes: tracks.fileSizeBytes,
      speaker: tracks.speaker,
      isTranslation: tracks.isTranslation,
    })
    .from(tracks)
    .where(isNotNull(tracks.s3Key));

  console.log(`Found ${dbTracks.length} tracks in DB with s3Key\n`);

  // 3. Build composite index: size → tracks (grouped by date prefix)
  const sizeIndex = new Map<number, typeof dbTracks>();
  for (const t of dbTracks) {
    if (!t.fileSizeBytes) continue;
    const existing = sizeIndex.get(t.fileSizeBytes) || [];
    existing.push(t);
    sizeIndex.set(t.fileSizeBytes, existing);
  }

  // 4. Match S3 files to DB tracks
  let updated = 0;
  let alreadyCorrect = 0;
  let noMatch = 0;
  let ambiguous = 0;

  for (const s3File of audioFiles) {
    const s3Filename = s3File.key.split("/").pop() || "";
    const s3Speaker = extractSpeaker(s3Filename);
    const s3DatePrefix = extractDatePrefix(s3File.key);
    const candidates = sizeIndex.get(s3File.size) || [];

    if (candidates.length === 0) {
      console.log(`NO MATCH: ${s3File.key} (${s3File.size} bytes)`);
      noMatch++;
      continue;
    }

    let match: (typeof candidates)[0] | null = null;

    if (candidates.length === 1) {
      match = candidates[0];
    } else {
      // Step 1: Filter by event date prefix (e.g. "20250417")
      let filtered = candidates;
      if (s3DatePrefix) {
        const dateMatches = candidates.filter(
          (t) => t.s3Key && extractDatePrefix(t.s3Key) === s3DatePrefix,
        );
        if (dateMatches.length > 0) filtered = dateMatches;
      }

      // Step 2: Filter by speaker
      if (filtered.length > 1 && s3Speaker) {
        const speakerMatches = filtered.filter((t) => {
          if (s3Speaker === "TRAD") return t.isTranslation;
          return t.speaker?.toUpperCase() === s3Speaker && !t.isTranslation;
        });
        if (speakerMatches.length > 0) filtered = speakerMatches;
      }

      // Step 3: If still ambiguous, prefer the track whose current s3Key
      // has the most specific event code (longer = more specific)
      if (filtered.length > 1) {
        filtered.sort(
          (a, b) => (b.s3Key?.length || 0) - (a.s3Key?.length || 0),
        );
      }

      if (filtered.length >= 1) {
        match = filtered[0];
      }
    }

    if (!match) {
      console.log(
        `AMBIGUOUS: ${s3Filename} → ${candidates.length} candidates`,
      );
      for (const c of candidates) {
        console.log(`  - [${c.id}] ${c.title} (${c.s3Key})`);
      }
      ambiguous++;
      continue;
    }

    // Check if already correct
    if (match.s3Key === s3File.key) {
      alreadyCorrect++;
      continue;
    }

    console.log(`FIX: [${match.id}] ${match.title}`);
    console.log(`  OLD: ${match.s3Key}`);
    console.log(`  NEW: ${s3File.key}`);

    if (!isDryRun) {
      await db
        .update(tracks)
        .set({ s3Key: s3File.key, updatedAt: new Date() })
        .where(eq(tracks.id, match.id));
    }
    updated++;
  }

  console.log(`\n=== Results ===`);
  console.log(`Updated:         ${updated}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`No match:        ${noMatch}`);
  console.log(`Ambiguous:       ${ambiguous}`);
  console.log(`Total S3 files:  ${audioFiles.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
