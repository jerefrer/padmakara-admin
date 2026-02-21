/**
 * Analyze all track naming patterns and identify anomalies
 */

import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";

console.log("=== Track Pattern Analysis ===\n");

// 1. Find tracks with empty parentheses
console.log("1. EMPTY PARENTHESES - tracks ending with ()");
const emptyParens = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    e.title_en,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) FILTER (WHERE t.original_filename LIKE '%()%') as examples
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE t.original_filename LIKE '%()%'
  GROUP BY e.event_code, e.title_en
  ORDER BY e.event_code
`);
const emptyParensResults = Array.isArray(emptyParens) ? emptyParens : emptyParens.rows || [];
console.log(`Found ${emptyParensResults.length} events with empty parentheses\n`);
for (const row of emptyParensResults.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.track_count} tracks`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

// 2. Find tracks with .mp4 extension in title/filename
console.log("\n2. VIDEO FILES - tracks with .mp4 in filename");
const mp4Tracks = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) FILTER (WHERE t.original_filename ILIKE '%.mp4%') as examples
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE t.original_filename ILIKE '%.mp4%'
  GROUP BY e.event_code
  ORDER BY e.event_code
`);
const mp4Results = Array.isArray(mp4Tracks) ? mp4Tracks : mp4Tracks.rows || [];
console.log(`Found ${mp4Results.length} events with .mp4 in filenames\n`);
for (const row of mp4Results.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.track_count} tracks`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

// 3. Find "practice" tracks (Morning/Evening/Night practice)
console.log("\n3. PRACTICE SESSIONS - tracks with practice keywords");
const practiceTracks = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) as examples
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE
    t.original_filename ~* '(morning|evening|night|afternoon).*(practice|prayers)'
    OR t.original_filename ~* 'practice.*(morning|evening|night|afternoon)'
  GROUP BY e.event_code
  ORDER BY e.event_code
`);
const practiceResults = Array.isArray(practiceTracks) ? practiceTracks : practiceTracks.rows || [];
console.log(`Found ${practiceResults.length} events with practice sessions\n`);
for (const row of practiceResults.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.track_count} tracks`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

// 4. Find Zoom recordings with audio markers
console.log("\n4. ZOOM RECORDINGS - tracks with [ENG/POR - Audio] pattern");
const zoomTracks = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) as examples,
    array_agg(DISTINCT t.is_translation) as translations
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE t.original_filename ~* '\\[(ENG|POR|PT|EN).*Audio\\]'
  GROUP BY e.event_code
  ORDER BY e.event_code
`);
const zoomResults = Array.isArray(zoomTracks) ? zoomTracks : zoomTracks.rows || [];
console.log(`Found ${zoomResults.length} events with Zoom audio markers\n`);
for (const row of zoomResults.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.track_count} tracks`);
  console.log(`  Is Translation: ${row.translations?.join(', ')}`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

// 5. Find tracks with JKR+TRAD or similar multi-speaker patterns
console.log("\n5. MULTI-SPEAKER - tracks with JKR+TRAD or similar");
const multiSpeaker = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) as examples
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE t.original_filename ~* '(JKR|TPWR|TRAD).*(\\+|&).*(JKR|TPWR|TRAD)'
  GROUP BY e.event_code
  ORDER BY e.event_code
`);
const multiResults = Array.isArray(multiSpeaker) ? multiSpeaker : multiSpeaker.rows || [];
console.log(`Found ${multiResults.length} events with multi-speaker tracks\n`);
for (const row of multiResults.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.track_count} tracks`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

// 6. Events with transcripts but no tracks
console.log("\n6. TRANSCRIPT-ONLY EVENTS - events with transcripts but no audio/video");
const transcriptOnly = await db.execute(sql`
  SELECT DISTINCT
    e.event_code,
    e.title_en,
    COUNT(DISTINCT tr.id) as transcript_count,
    COUNT(DISTINCT t.id) as track_count
  FROM retreats e
  LEFT JOIN transcripts tr ON tr.retreat_id = e.id
  LEFT JOIN sessions s ON s.retreat_id = e.id
  LEFT JOIN tracks t ON t.session_id = s.id
  WHERE tr.id IS NOT NULL
  GROUP BY e.event_code, e.title_en
  HAVING COUNT(DISTINCT t.id) = 0
  ORDER BY e.event_code
`);
const transcriptOnlyResults = Array.isArray(transcriptOnly) ? transcriptOnly : transcriptOnly.rows || [];
console.log(`Found ${transcriptOnlyResults.length} events with transcripts but no tracks\n`);
for (const row of transcriptOnlyResults.slice(0, 10)) {
  console.log(`${row.event_code}: ${row.transcript_count} transcripts, ${row.track_count} tracks`);
}

// 7. Events with AM/PM that should be split into sessions
console.log("\n7. AM/PM PATTERNS - events that should be split into sessions");
const ampmEvents = await db.execute(sql`
  SELECT
    e.event_code,
    COUNT(DISTINCT s.id) as session_count,
    COUNT(t.id) as track_count,
    array_agg(DISTINCT t.original_filename ORDER BY t.original_filename) FILTER (WHERE t.original_filename ~* '_(AM|PM)') as examples
  FROM tracks t
  JOIN sessions s ON t.session_id = s.id
  JOIN retreats e ON s.retreat_id = e.id
  WHERE t.original_filename ~* '_(AM|PM)'
  GROUP BY e.event_code
  HAVING COUNT(DISTINCT s.id) = 1
  ORDER BY e.event_code
`);
const ampmResults = Array.isArray(ampmEvents) ? ampmEvents : ampmEvents.rows || [];
console.log(`Found ${ampmResults.length} events with AM/PM in single session (should split)\n`);
for (const row of ampmResults.slice(0, 5)) {
  console.log(`${row.event_code}: ${row.session_count} sessions, ${row.track_count} tracks`);
  console.log(`  Examples: ${row.examples?.slice(0, 2).join(', ')}\n`);
}

console.log("\n=== Summary ===");
console.log(`Empty parentheses: ${emptyParensResults.length} events`);
console.log(`MP4 in filenames: ${mp4Results.length} events`);
console.log(`Practice sessions: ${practiceResults.length} events`);
console.log(`Zoom recordings: ${zoomResults.length} events`);
console.log(`Multi-speaker: ${multiResults.length} events`);
console.log(`Transcript-only: ${transcriptOnlyResults.length} events`);
console.log(`AM/PM to split: ${ampmResults.length} events`);
