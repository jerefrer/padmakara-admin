/**
 * Migration 001: Add new fields to tracks table
 * - isPractice: boolean for practice sessions
 * - fileFormat: string for file extension (mp3, m4a, mp4, etc.)
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/index.ts";

console.log("=== Migration 001: Add Track Fields ===\n");

try {
  // Add isPractice field
  console.log("Adding is_practice column...");
  await db.execute(sql`
    ALTER TABLE tracks
    ADD COLUMN IF NOT EXISTS is_practice BOOLEAN NOT NULL DEFAULT FALSE
  `);
  console.log("✓ is_practice column added\n");

  // Add fileFormat field
  console.log("Adding file_format column...");
  await db.execute(sql`
    ALTER TABLE tracks
    ADD COLUMN IF NOT EXISTS file_format TEXT
  `);
  console.log("✓ file_format column added\n");

  // Extract file format from original_filename
  console.log("Extracting file formats from filenames...");
  await db.execute(sql`
    UPDATE tracks
    SET file_format = LOWER(SUBSTRING(original_filename FROM '\\.([^.]+)$'))
    WHERE original_filename IS NOT NULL AND file_format IS NULL
  `);
  const formatResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM tracks WHERE file_format IS NOT NULL
  `);
  const formatCount = Array.isArray(formatResult) ? formatResult[0]?.count : formatResult.rows?.[0]?.count;
  console.log(`✓ Set file_format for ${formatCount} tracks\n`);

  // Mark practice sessions
  console.log("Marking practice sessions...");
  await db.execute(sql`
    UPDATE tracks
    SET is_practice = TRUE
    WHERE (
      original_filename ~* '(morning|evening|night|afternoon).*(practice|prayers)'
      OR original_filename ~* 'practice.*(morning|evening|night|afternoon)'
      OR title ~* '(morning|evening|night|afternoon).*(practice|prayers)'
      OR title ~* 'practice.*(morning|evening|night|afternoon)'
    )
    AND is_practice = FALSE
  `);
  const practiceResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM tracks WHERE is_practice = TRUE
  `);
  const practiceCount = Array.isArray(practiceResult) ? practiceResult[0]?.count : practiceResult.rows?.[0]?.count;
  console.log(`✓ Marked ${practiceCount} practice sessions\n`);

  console.log("✅ Migration 001 completed successfully");
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
}
