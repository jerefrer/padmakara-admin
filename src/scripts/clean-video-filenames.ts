/**
 * Clean video filenames - remove .mp4 extension from display names
 * The file format is already stored in the file_format column
 */

import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";

console.log("=== Clean Video Filenames ===\n");

// Remove .mp4 extension from titles
console.log("Removing .mp4 extension from track titles...");
const titleResult = await db.execute(sql`
  UPDATE tracks
  SET title = REGEXP_REPLACE(title, '\\.mp4$', '', 'i')
  WHERE title ~* '\\.mp4$'
  RETURNING id, title, original_filename
`);
const titleTracks = Array.isArray(titleResult) ? titleResult : titleResult.rows || [];
console.log(`✓ Cleaned ${titleTracks.length} track titles\n`);
for (const track of titleTracks) {
  console.log(`  - ${track.title} (${track.original_filename})`);
}

// Remove .mp4 from originalFilename display (keep for reference but clean for display)
console.log("\nRemoving .mp4 extension from original filenames...");
const filenameResult = await db.execute(sql`
  UPDATE tracks
  SET original_filename = REGEXP_REPLACE(original_filename, '\\.mp4$', '', 'i')
  WHERE original_filename ~* '\\.mp4$' AND file_format = 'mp4'
  RETURNING id, original_filename
`);
const filenameTracks = Array.isArray(filenameResult) ? filenameResult : filenameResult.rows || [];
console.log(`✓ Cleaned ${filenameTracks.length} original filenames\n`);
for (const track of filenameTracks) {
  console.log(`  - ${track.original_filename}`);
}

console.log("\n✅ Video filenames cleaned successfully");
console.log("📝 Note: File format (.mp4) is preserved in the file_format column for display as badge");
