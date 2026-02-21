/**
 * Migration 002: Make transcripts event-level only
 * - Check if session_id exists
 * - Set all sessionId to NULL
 * - Remove session_id foreign key constraint
 * - Drop session_id column
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/index.ts";

console.log("=== Migration 002: Transcripts Event-Level Only ===\n");

try {
  // Check if session_id column exists
  const columnCheck = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'transcripts' AND column_name = 'session_id'
  `);
  const columns = Array.isArray(columnCheck) ? columnCheck : columnCheck.rows || [];
  const columnExists = columns.length > 0;

  if (!columnExists) {
    console.log("✓ session_id column already removed from transcripts\n");
    console.log("✅ Migration 002 already completed (column does not exist)");
  } else {
    // Set all sessionId to NULL
    console.log("Setting all transcript sessionId to NULL...");
    await db.execute(sql`
      UPDATE transcripts
      SET session_id = NULL
      WHERE session_id IS NOT NULL
    `);
    const nullResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM transcripts WHERE session_id IS NULL
    `);
    const nullCount = Array.isArray(nullResult) ? nullResult[0]?.count : nullResult.rows?.[0]?.count;
    console.log(`✓ ${nullCount} transcripts now have NULL sessionId\n`);

    // Drop the foreign key constraint
    console.log("Dropping session_id foreign key constraint...");
    await db.execute(sql`
      ALTER TABLE transcripts
      DROP CONSTRAINT IF EXISTS transcripts_session_id_sessions_id_fk
    `);
    console.log("✓ Foreign key constraint dropped\n");

    // Drop the column
    console.log("Dropping session_id column...");
    await db.execute(sql`
      ALTER TABLE transcripts
      DROP COLUMN IF EXISTS session_id
    `);
    console.log("✓ session_id column dropped\n");

    console.log("✅ Migration 002 completed successfully");
  }
  console.log("📝 Note: Schema file already updated to remove sessionId field and session relation");
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
}
