/**
 * Find events with tracks that have "am" or "pm" in their names
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
    LOWER(t.original_filename) LIKE '%am%'
    OR LOWER(t.original_filename) LIKE '%pm%'
    OR LOWER(t.title) LIKE '%am%'
    OR LOWER(t.title) LIKE '%pm%'
  GROUP BY e.event_code, e.title_en, e.title_pt
  ORDER BY e.event_code
`);

console.log("\n=== Events with 'am' or 'pm' in track names ===\n");
const results = Array.isArray(tracks) ? tracks : tracks.rows || [];
console.log(`Found ${results.length} events\n`);

for (const row of results) {
  console.log(`${row.event_code}`);
  console.log(`  Title: ${row.title_en || row.title_pt}`);
  console.log(`  Tracks with am/pm: ${row.track_count}`);
  console.log(`  Sample filenames:`);
  const samples = row.sample_filenames.slice(0, 3);
  for (const filename of samples) {
    console.log(`    - ${filename}`);
  }
  if (row.sample_filenames.length > 3) {
    console.log(`    ... and ${row.sample_filenames.length - 3} more`);
  }
  console.log();
}
