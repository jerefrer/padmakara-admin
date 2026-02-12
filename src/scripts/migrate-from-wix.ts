/**
 * Main Wix migration script: Import all 193 retreats from the Wix CSV export.
 *
 * This script:
 * 1. Reads the CSV and parses each row
 * 2. Creates retreat records with metadata
 * 3. Links retreats to teachers, places, and groups
 * 4. Creates track records from the embedded track name lists
 * 5. Creates transcript records where available
 *
 * Prerequisites:
 * - Run seed-from-csv.ts first to populate teachers, places, and groups
 * - Database must be migrated and accessible
 *
 * Usage:
 *   bun run src/scripts/migrate-from-wix.ts <path-to-csv>
 *   bun run src/scripts/migrate-from-wix.ts <path-to-csv> --dry-run
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { eq, ilike } from "drizzle-orm";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { places } from "../db/schema/places.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { retreats, retreatTeachers, retreatPlaces, retreatGroupRetreats } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import {
  parseWixRow,
  parseDateRange,
  parseTeachers,
  parseOrganizations,
  parseTrackCount,
  type WixRow,
} from "./csv-parser.ts";
import { parseTrackFilename, inferSessions } from "../services/track-parser.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const csvPath = args.find((a) => !a.startsWith("--"));

if (!csvPath) {
  console.error("Usage: bun run src/scripts/migrate-from-wix.ts <path-to-csv> [--dry-run]");
  process.exit(1);
}

if (dryRun) console.log("=== DRY RUN MODE — no database writes ===\n");

const csvContent = readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, "");
const rawRows: Record<string, string>[] = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
});

console.log(`Parsed ${rawRows.length} rows from CSV`);

// --- Load lookup tables ---
const allTeachers = await db.select().from(teachers);
const allPlaces = await db.select().from(places);
const allGroups = await db.select().from(retreatGroups);

function findTeacher(name: string) {
  return allTeachers.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
}

function findPlace(location: string) {
  return allPlaces.find(
    (p) => p.location?.toLowerCase() === location.toLowerCase(),
  );
}

function findGroup(name: string) {
  return allGroups.find(
    (g) =>
      g.nameEn?.toLowerCase() === name.toLowerCase() ||
      g.namePt?.toLowerCase() === name.toLowerCase(),
  );
}

// --- Counters ---
let retreatsCreated = 0;
let sessionsCreated = 0;
let tracksCreated = 0;
let transcriptsCreated = 0;
let errors: string[] = [];

// --- Process each row ---
for (const raw of rawRows) {
  const row = parseWixRow(raw);

  if (!row.eventCode) {
    errors.push("Skipping row with empty eventCode");
    continue;
  }

  console.log(`\n--- ${row.eventCode}: ${row.title} ---`);

  const { startDate, endDate } = parseDateRange(row.dateRange);

  // Determine status based on OnOff field
  const status = row.onOff ? "published" : "draft";

  // Build S3 prefix from download URL
  const s3Prefix = extractS3Prefix(row.audio1.downloadUrl);

  if (dryRun) {
    console.log(`  Would create retreat: ${row.title}`);
    console.log(`  Dates: ${startDate} → ${endDate}`);
    console.log(`  Status: ${status}`);
    console.log(`  Teachers: ${parseTeachers(row.teacherName).join(", ")}`);
    console.log(`  Place: ${row.place}`);
    console.log(`  Groups: ${parseOrganizations(row.organization).join(", ")}`);
    console.log(`  Audio1 tracks: ${row.audio1.trackNames.length}`);
    console.log(`  Audio2 tracks: ${row.audio2.trackNames.length}`);
    retreatsCreated++;
    tracksCreated += row.audio1.trackNames.length + row.audio2.trackNames.length;
    continue;
  }

  try {
    // --- Create retreat ---
    const [retreat] = await db
      .insert(retreats)
      .values({
        eventCode: row.eventCode,
        titlePt: row.title || null,
        titleEn: row.title || row.eventCode,
        descriptionPt: row.description || null,
        descriptionEn: row.description || null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        designation: row.designation || null,
        audience: row.audience || null,
        bibliography: row.bibliography || null,
        sessionThemes: row.sessionThemes || null,
        notes: row.notes || null,
        status,
        s3Prefix: s3Prefix || null,
        wixId: row.wixId || null,
      })
      .onConflictDoNothing()
      .returning();

    if (!retreat) {
      console.log(`  Already exists, skipping`);
      continue;
    }

    retreatsCreated++;

    // --- Link teachers ---
    const teacherNames = parseTeachers(row.teacherName);
    for (const tName of teacherNames) {
      const teacher = findTeacher(tName);
      if (teacher) {
        await db
          .insert(retreatTeachers)
          .values({ retreatId: retreat.id, teacherId: teacher.id, role: "teacher" })
          .onConflictDoNothing();
      } else {
        errors.push(`Teacher not found: "${tName}" (retreat ${row.eventCode})`);
      }
    }

    // Link guest teacher
    if (row.guestName) {
      const guest = findTeacher(row.guestName);
      if (guest) {
        await db
          .insert(retreatTeachers)
          .values({ retreatId: retreat.id, teacherId: guest.id, role: "guest" })
          .onConflictDoNothing();
      }
    }

    // --- Link place ---
    if (row.place) {
      const place = findPlace(row.place);
      if (place) {
        await db
          .insert(retreatPlaces)
          .values({ retreatId: retreat.id, placeId: place.id })
          .onConflictDoNothing();
      } else {
        errors.push(`Place not found: "${row.place}" (retreat ${row.eventCode})`);
      }
    }

    // --- Link groups ---
    for (const orgName of parseOrganizations(row.organization)) {
      const group = findGroup(orgName);
      if (group) {
        await db
          .insert(retreatGroupRetreats)
          .values({ retreatId: retreat.id, retreatGroupId: group.id })
          .onConflictDoNothing();
      } else {
        errors.push(`Group not found: "${orgName}" (retreat ${row.eventCode})`);
      }
    }

    // --- Create sessions and tracks from audio1 ---
    if (row.audio1.trackNames.length > 0) {
      const { s: sessionCount, t: trackCount } = await importTracks(
        retreat.id,
        row.audio1.trackNames,
        s3Prefix,
        false,
      );
      sessionsCreated += sessionCount;
      tracksCreated += trackCount;
    }

    // --- Create tracks from audio2 (translations) ---
    if (row.audio2.trackNames.length > 0) {
      const { t: trackCount } = await importTracks(
        retreat.id,
        row.audio2.trackNames,
        s3Prefix ? `${s3Prefix}/audio2` : null,
        true,
      );
      tracksCreated += trackCount;
    }

    // --- Create transcript records ---
    if (row.transcript1.language) {
      await createTranscript(retreat.id, row.transcript1, 1);
      transcriptsCreated++;
    }
    if (row.transcript2.language) {
      await createTranscript(retreat.id, row.transcript2, 2);
      transcriptsCreated++;
    }

    console.log(`  ✓ Created`);
  } catch (err: any) {
    errors.push(`Error processing ${row.eventCode}: ${err.message}`);
    console.error(`  ✗ Error: ${err.message}`);
  }
}

// --- Summary ---
console.log("\n\n========== MIGRATION SUMMARY ==========");
console.log(`Retreats created:    ${retreatsCreated}`);
console.log(`Sessions created:    ${sessionsCreated}`);
console.log(`Tracks created:      ${tracksCreated}`);
console.log(`Transcripts created: ${transcriptsCreated}`);
if (errors.length > 0) {
  console.log(`\nErrors (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
}
if (dryRun) console.log("\n(Dry run — no data was written)");
console.log("========================================\n");

process.exit(errors.length > 0 ? 1 : 0);

// ====== Helper functions ======

/**
 * Import tracks for a retreat, inferring sessions from filenames.
 * Returns counts of sessions and tracks created.
 */
async function importTracks(
  retreatId: number,
  trackNames: string[],
  s3Prefix: string | null,
  isTranslationSet: boolean,
): Promise<{ s: number; t: number }> {
  // Parse filenames into ParsedTrack objects
  const parsed = trackNames.map((name) => parseTrackFilename(name));

  // Infer sessions from parsed tracks
  const inferred = inferSessions(parsed);

  let sessionCount = 0;
  let trackCount = 0;

  for (const sess of inferred) {
    // Create or find session
    const [session] = await db
      .insert(sessions)
      .values({
        retreatId,
        titleEn: sess.titleEn || `Session ${sess.sessionNumber}`,
        sessionNumber: sess.sessionNumber,
        sessionDate: sess.date ?? null,
        timePeriod: sess.timePeriod ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (session) sessionCount++;
    const sessionId = session?.id;

    if (!sessionId) continue;

    // Create track records
    for (const track of sess.tracks) {
      const s3Key = s3Prefix
        ? `${s3Prefix}/${track.originalFilename}`
        : null;

      await db
        .insert(tracks)
        .values({
          sessionId,
          title: track.title || track.originalFilename.replace(/\.mp3$/i, ""),
          trackNumber: track.trackNumber,
          language: track.language ?? (isTranslationSet ? "pt" : "en"),
          isTranslation: track.isTranslation ?? isTranslationSet,
          s3Key,
          originalFilename: track.originalFilename,
        })
        .onConflictDoNothing();

      trackCount++;
    }
  }

  return { s: sessionCount, t: trackCount };
}

/**
 * Create a transcript record from Wix data.
 */
async function createTranscript(
  retreatId: number,
  data: WixRow["transcript1"],
  index: number,
) {
  const lang = mapLanguage(data.language);
  const pageCount = data.pages ? parseInt(data.pages, 10) || null : null;

  // Extract S3 key from download URL if it's an S3 URL
  let s3Key: string | null = null;
  if (data.pdfDownload?.includes("s3.")) {
    try {
      const url = new URL(data.pdfDownload);
      s3Key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      // Not a valid URL
    }
  }

  await db
    .insert(transcripts)
    .values({
      retreatId,
      language: lang,
      s3Key,
      pageCount,
      status: data.status || "available",
    })
    .onConflictDoNothing();
}

/** Extract S3 prefix from a download URL */
function extractS3Prefix(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("s3")) return null;
    // Path looks like /mediateca/2010-03-08-MTR-CFR-ACM/...
    const path = decodeURIComponent(parsed.pathname).replace(/^\//, "");
    // Remove trailing filename (zip, etc.)
    const parts = path.split("/");
    // Keep up to the retreat-level directory
    if (parts.length >= 2) return parts.slice(0, 2).join("/");
    return path;
  } catch {
    return null;
  }
}

/** Map Portuguese language names to ISO codes */
function mapLanguage(lang: string): string {
  if (!lang) return "unknown";
  const lower = lang.toLowerCase().trim();
  if (lower.includes("portugu")) return "pt";
  if (lower.includes("ingl")) return "en";
  if (lower.includes("english")) return "en";
  if (lower.includes("tibetan") || lower.includes("tibetano")) return "tib";
  if (lower.includes("franc") || lower.includes("french")) return "fr";
  return "unknown";
}
