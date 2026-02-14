/**
 * Fix Zoom recording translation flags
 * - [ENG - Audio/Video] should be isTranslation: false (original)
 * - [POR - Audio/Video] should be isTranslation: true (translation)
 */

import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";

console.log("=== Fix Zoom Translation Flags ===\n");

// Fix ENG tracks (should NOT be translations)
console.log("Fixing [ENG - Audio/Video] tracks...");
const engResult = await db.execute(sql`
  UPDATE tracks
  SET is_translation = FALSE
  WHERE original_filename ~* '\\[(ENG|EN).*Audio\\]'
     OR original_filename ~* '\\[(ENG|EN).*Video\\]'
  RETURNING id, original_filename
`);
const engTracks = Array.isArray(engResult) ? engResult : engResult.rows || [];
console.log(`✓ Fixed ${engTracks.length} ENG tracks (set isTranslation = false)\n`);
for (const track of engTracks.slice(0, 3)) {
  console.log(`  - ${track.original_filename}`);
}
if (engTracks.length > 3) {
  console.log(`  ... and ${engTracks.length - 3} more\n`);
}

// Fix POR tracks (should be translations)
console.log("\nFixing [POR - Audio/Video] tracks...");
const porResult = await db.execute(sql`
  UPDATE tracks
  SET is_translation = TRUE
  WHERE original_filename ~* '\\[(POR|PT).*Audio\\]'
     OR original_filename ~* '\\[(POR|PT).*Video\\]'
  RETURNING id, original_filename
`);
const porTracks = Array.isArray(porResult) ? porResult : porResult.rows || [];
console.log(`✓ Fixed ${porTracks.length} POR tracks (set isTranslation = true)\n`);
for (const track of porTracks.slice(0, 3)) {
  console.log(`  - ${track.original_filename}`);
}
if (porTracks.length > 3) {
  console.log(`  ... and ${porTracks.length - 3} more\n`);
}

// Link POR tracks to their ENG originals
console.log("\nLinking POR translations to ENG originals...");
const linkedResult = await db.execute(sql`
  WITH eng_tracks AS (
    SELECT
      t.id as eng_id,
      t.session_id,
      REGEXP_REPLACE(t.original_filename, '\\[(ENG|EN).*\\]', '', 'i') as base_name
    FROM tracks t
    WHERE t.original_filename ~* '\\[(ENG|EN).*(Audio|Video)\\]'
  ),
  por_tracks AS (
    SELECT
      t.id as por_id,
      t.session_id,
      REGEXP_REPLACE(t.original_filename, '\\[(POR|PT).*\\]', '', 'i') as base_name
    FROM tracks t
    WHERE t.original_filename ~* '\\[(POR|PT).*(Audio|Video)\\]'
  )
  UPDATE tracks t
  SET original_track_id = e.eng_id
  FROM por_tracks p
  JOIN eng_tracks e ON e.session_id = p.session_id AND e.base_name = p.base_name
  WHERE t.id = p.por_id
  RETURNING t.id, t.original_filename
`);
const linkedTracks = Array.isArray(linkedResult) ? linkedResult : linkedResult.rows || [];
console.log(`✓ Linked ${linkedTracks.length} POR tracks to their ENG originals\n`);

console.log("✅ Zoom translation flags fixed successfully");
