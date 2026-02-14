/**
 * Find events with tracks that have standalone "am" or "pm" in their names
 * (likely indicating morning/afternoon sessions)
 */

import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";

const tracks = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    e.title_en,
    e.title_pt,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) as sample_filenames
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE
    t.original_filename ~* '\\y(am|pm)\\y'
    OR t.title ~* '\\y(am|pm)\\y'
  GROUP BY e.event_code, e.title_en, e.title_pt
  ORDER BY e.event_code
`);

console.log("\n=== Events with standalone 'am' or 'pm' in track names ===\n");
const results = Array.isArray(tracks) ? tracks : tracks.rows || [];
console.log(`Found ${results.length} events\n`);

for (const row of results) {
  console.log(`${row.event_code}`);
  console.log(`  Title: ${row.title_en || row.title_pt}`);
  console.log(`  Tracks with am/pm: ${row.track_count}`);
  console.log(`  Sample filenames:`);
  const samples = row.sample_filenames.slice(0, 5);
  for (const filename of samples) {
    console.log(`    - ${filename}`);
  }
  if (row.sample_filenames.length > 5) {
    console.log(`    ... and ${row.sample_filenames.length - 5} more`);
  }
  console.log();
}
