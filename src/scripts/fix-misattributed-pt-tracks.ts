/**
 * Fix tracks where original_language='pt' / is_translation=false but the title is
 * actually English. These were created when migrate-from-wix-v2 inserted the SRR/JKR
 * line from `audio2-tracksTitles` ahead of the matching TRAD line, so the SRR record
 * claimed the (session_id, track_number, 'pt') unique key and the real translation
 * was silently dropped by `onConflictDoNothing()`.
 *
 * For each candidate the script does one of three things:
 *
 *   1. DELETE  — a properly translated PT track already exists in the same session
 *                with is_translation=true at the same numeric prefix. The bad row is
 *                a stale duplicate (often parked at a negative track_number).
 *   2. UPDATE  — no good twin in DB, but `audio2-tracksTitles` contains a `NNN TRAD`
 *                line for that prefix. Rewrite title / original_filename / s3_key /
 *                is_translation / original_track_id / languages to point at the TRAD
 *                file. Clear duration_seconds, file_size_bytes, read_along_s3_key
 *                because they belong to the wrong audio file.
 *   3. SKIP    — no TRAD line exists for that prefix. The track is legitimate
 *                Portuguese content (e.g. PWR speaking PT directly). Leave it alone.
 *
 * Usage:
 *   bun run src/scripts/fix-misattributed-pt-tracks.ts                    # dry-run, all events
 *   bun run src/scripts/fix-misattributed-pt-tracks.ts --execute          # apply, all events
 *   bun run src/scripts/fix-misattributed-pt-tracks.ts --event 616        # dry-run, one event
 *   bun run src/scripts/fix-misattributed-pt-tracks.ts --event 616 --execute
 *   bun run src/scripts/fix-misattributed-pt-tracks.ts --csv /path/to/wix.csv
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { sessions } from "../db/schema/sessions.ts";
import { events } from "../db/schema/retreats.ts";
import { parseWixRow, type WixRow } from "./csv-parser.ts";
import { parseTrackFilename } from "../services/track-parser.ts";

const DEFAULT_CSV =
  "/Users/jeremy/Documents/Programming/padmakara-backend-frontend/wix-export-20250821.csv";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--execute");
const csvIdx = args.indexOf("--csv");
const csvPath = csvIdx >= 0 ? args[csvIdx + 1]! : DEFAULT_CSV;
const eventIdx = args.indexOf("--event");
const onlyEventId = eventIdx >= 0 ? parseInt(args[eventIdx + 1]!, 10) : null;

if (DRY_RUN) console.log("=== DRY RUN (pass --execute to apply changes) ===\n");
console.log(`CSV: ${csvPath}`);
if (onlyEventId !== null) console.log(`Restricting to event_id = ${onlyEventId}`);
console.log();

// ---------------------------------------------------------------------------
// Load Wix CSV indexed by event_code
// ---------------------------------------------------------------------------

const csvText = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
const rawRows = parse(csvText, {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
}) as Record<string, string>[];

const wixByCode = new Map<string, WixRow>();
for (const raw of rawRows) {
  const row = parseWixRow(raw);
  if (row.eventCode) wixByCode.set(row.eventCode, row);
}
console.log(`Loaded ${wixByCode.size} Wix events from CSV\n`);

// ---------------------------------------------------------------------------
// Find candidate tracks
// ---------------------------------------------------------------------------

const TEACHER_CODES = "SRR|JKR|PWR|KPS|CNR|YMR|DK|MTTR|SHR|TKR|DPR|TLR";

const whereClauses = [
  eq(tracks.originalLanguage, "pt"),
  eq(tracks.isTranslation, false),
  sql`${tracks.originalFilename} ~ ${`^[0-9]+\\s+(${TEACHER_CODES})\\s+-`}`,
];
if (onlyEventId !== null) {
  whereClauses.push(eq(events.id, onlyEventId));
}

const candidates = await db
  .select({
    trackId: tracks.id,
    sessionId: tracks.sessionId,
    trackNumber: tracks.trackNumber,
    title: tracks.title,
    originalFilename: tracks.originalFilename,
    s3Key: tracks.s3Key,
    eventId: events.id,
    eventCode: events.eventCode,
  })
  .from(tracks)
  .innerJoin(sessions, eq(sessions.id, tracks.sessionId))
  .innerJoin(events, eq(events.id, sessions.eventId))
  .where(and(...whereClauses))
  .orderBy(events.id, tracks.sessionId, tracks.id);

console.log(`Found ${candidates.length} candidate track(s)\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFilePrefix(filename: string | null): number | null {
  if (!filename) return null;
  const m = filename.match(/^(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

function findTradLine(audio2: string[], prefix: number): string | null {
  const padded3 = String(prefix).padStart(3, "0");
  const padded2 = String(prefix).padStart(2, "0");
  const candidates = audio2.filter((line) => {
    const m = line.match(/^(\d+)/);
    if (!m) return false;
    const n = m[1]!;
    if (parseInt(n, 10) !== prefix) return false;
    return /(?:^|\s|_)TRAD(?:\s|$|-)/i.test(line);
  });
  if (candidates.length === 0) return null;
  // Prefer a line whose padding matches the original (3-digit vs 2-digit) so
  // we don't accidentally match `01 TRAD` when the bad track is `001 PWR`.
  return (
    candidates.find((l) => l.startsWith(padded3 + " ") || l.startsWith(padded3 + "a ") || l.startsWith(padded3 + "_")) ??
    candidates.find((l) => l.startsWith(padded2 + " ") || l.startsWith(padded2 + "a ") || l.startsWith(padded2 + "_")) ??
    candidates[0]!
  );
}

// ---------------------------------------------------------------------------
// Plan changes
// ---------------------------------------------------------------------------

type Action =
  | { kind: "DELETE"; bad: typeof candidates[number]; goodTwinId: number }
  | {
      kind: "UPDATE";
      bad: typeof candidates[number];
      tradLine: string;
      newTitle: string;
      newS3Key: string | null;
      enTrackId: number | null;
    }
  | { kind: "SKIP"; bad: typeof candidates[number]; reason: string };

const actions: Action[] = [];

for (const bad of candidates) {
  const prefix = extractFilePrefix(bad.originalFilename);
  if (prefix === null) {
    actions.push({ kind: "SKIP", bad, reason: "no numeric prefix in filename" });
    continue;
  }

  // 1. Good twin already exists? (TRAD entry at the same prefix in same session)
  const goodTwin = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(
      and(
        eq(tracks.sessionId, bad.sessionId),
        eq(tracks.trackNumber, prefix),
        eq(tracks.originalLanguage, "pt"),
        eq(tracks.isTranslation, true),
      ),
    )
    .limit(1);
  if (goodTwin.length > 0) {
    actions.push({ kind: "DELETE", bad, goodTwinId: goodTwin[0]!.id });
    continue;
  }

  // 2. TRAD line in audio2?
  const wixRow = wixByCode.get(bad.eventCode);
  if (!wixRow) {
    actions.push({ kind: "SKIP", bad, reason: `no Wix row for event_code ${bad.eventCode}` });
    continue;
  }
  const tradLine = findTradLine(wixRow.audio2.trackNames, prefix);
  if (!tradLine) {
    actions.push({
      kind: "SKIP",
      bad,
      reason: `no TRAD line for prefix ${prefix} in audio2 (likely legitimate PT teacher content)`,
    });
    continue;
  }

  // Find the matching EN track in same session for original_track_id
  const enTrack = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(
      and(
        eq(tracks.sessionId, bad.sessionId),
        eq(tracks.trackNumber, prefix),
        eq(tracks.originalLanguage, "en"),
      ),
    )
    .limit(1);

  const newTitle = parseTrackFilename(tradLine).title || tradLine.replace(/\.mp3$/i, "");
  const newS3Key = bad.s3Key && bad.originalFilename
    ? bad.s3Key.replace(bad.originalFilename, tradLine)
    : null;

  actions.push({
    kind: "UPDATE",
    bad,
    tradLine,
    newTitle,
    newS3Key,
    enTrackId: enTrack[0]?.id ?? null,
  });
}

// ---------------------------------------------------------------------------
// Print plan grouped by event
// ---------------------------------------------------------------------------

const byEvent = new Map<number, Action[]>();
for (const a of actions) {
  const list = byEvent.get(a.bad.eventId) ?? [];
  list.push(a);
  byEvent.set(a.bad.eventId, list);
}

for (const [eventId, list] of [...byEvent.entries()].sort((a, b) => a[0] - b[0])) {
  const code = list[0]!.bad.eventCode;
  console.log(`\n── Event ${eventId} (${code}) ──`);
  for (const a of list) {
    if (a.kind === "DELETE") {
      console.log(
        `  DELETE  track ${a.bad.trackId}  #${a.bad.trackNumber}  "${a.bad.title}"`
      );
      console.log(`          good twin in DB: track ${a.goodTwinId}`);
    } else if (a.kind === "UPDATE") {
      console.log(
        `  UPDATE  track ${a.bad.trackId}  prefix ${extractFilePrefix(a.bad.originalFilename)}`
      );
      console.log(`          title:    "${a.bad.title}"`);
      console.log(`             →      "${a.newTitle}"`);
      console.log(`          file:     ${a.bad.originalFilename}`);
      console.log(`             →      ${a.tradLine}`);
      console.log(`          s3_key:   ${a.bad.s3Key}`);
      console.log(`             →      ${a.newS3Key}`);
      console.log(`          is_translation: false → true`);
      console.log(`          original_track_id: → ${a.enTrackId ?? "(EN track not found)"}`);
    } else {
      console.log(`  SKIP    track ${a.bad.trackId}  "${a.bad.title}"  — ${a.reason}`);
    }
  }
}

const counts = {
  DELETE: actions.filter((a) => a.kind === "DELETE").length,
  UPDATE: actions.filter((a) => a.kind === "UPDATE").length,
  SKIP: actions.filter((a) => a.kind === "SKIP").length,
};
console.log(`\nPlan: ${counts.DELETE} delete · ${counts.UPDATE} update · ${counts.SKIP} skip`);

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log("\n=== DRY RUN — no changes made ===");
  process.exit(0);
}

let applied = 0;
for (const a of actions) {
  if (a.kind === "DELETE") {
    await db.delete(tracks).where(eq(tracks.id, a.bad.trackId));
    applied++;
  } else if (a.kind === "UPDATE") {
    await db
      .update(tracks)
      .set({
        title: a.newTitle,
        originalFilename: a.tradLine,
        s3Key: a.newS3Key,
        isTranslation: true,
        originalTrackId: a.enTrackId,
        languages: ["pt"],
        // The previous values referred to the wrong audio file; clear so they
        // get re-populated by populate-track-durations.ts and the read-along
        // pipeline re-runs against the correct audio.
        durationSeconds: 0,
        fileSizeBytes: null,
        readAlongS3Key: null,
        updatedAt: new Date(),
      })
      .where(eq(tracks.id, a.bad.trackId));
    applied++;
  }
}

console.log(`\nApplied ${applied} change(s).`);
console.log("\nFollow-up:");
console.log("  • Run populate-track-durations.ts to refresh duration/file size");
console.log("  • Re-run the read-along pipeline for updated tracks");
process.exit(0);
