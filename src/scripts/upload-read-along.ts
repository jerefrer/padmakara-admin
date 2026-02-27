/**
 * Upload Read Along alignment JSONs to S3 and update track DB records.
 *
 * Usage: bun run src/scripts/upload-read-along.ts <eventCode> <alignmentDir>
 * Example: bun run src/scripts/upload-read-along.ts 20240418-JKR-PP3-CCA ../../read-along/test-event/output
 */
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { generatePresignedUploadUrl } from "../services/s3.ts";

const eventCode = process.argv[2];
const alignmentDir = process.argv[3];

if (!eventCode || !alignmentDir) {
  console.error("Usage: bun run src/scripts/upload-read-along.ts <eventCode> <alignmentDir>");
  process.exit(1);
}

// 1. List all JSON files in the alignment directory (skip summary)
const files = (await readdir(alignmentDir))
  .filter((f) => f.endsWith(".json") && f !== "alignment_summary.json");

console.log(`Found ${files.length} alignment files in ${alignmentDir}`);

// 2. For each file, find the matching track and upload
let uploaded = 0;
let skipped = 0;

for (const jsonFile of files) {
  const mp3Name = jsonFile.replace(/\.json$/, ".mp3");
  const s3Key = `events/${eventCode}/read-along/${jsonFile}`;

  // Find track by originalFilename
  const track = await db.query.tracks.findFirst({
    where: eq(tracks.originalFilename, mp3Name),
  });

  if (!track) {
    console.warn(`  SKIP: No track found for "${mp3Name}"`);
    skipped++;
    continue;
  }

  // Read the JSON file
  const content = await readFile(join(alignmentDir, jsonFile));

  // Upload to S3 using presigned URL
  const uploadUrl = await generatePresignedUploadUrl(s3Key, "application/json", 300);
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    body: content,
    headers: { "Content-Type": "application/json" },
  });

  if (!uploadResponse.ok) {
    console.error(`  FAIL: Upload failed for ${jsonFile}: ${uploadResponse.status}`);
    continue;
  }

  // Update DB record
  await db
    .update(tracks)
    .set({ readAlongS3Key: s3Key })
    .where(eq(tracks.id, track.id));

  console.log(`  OK: track ${track.id} (#${track.trackNumber}) → ${s3Key}`);
  uploaded++;
}

console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped`);
process.exit(0);
