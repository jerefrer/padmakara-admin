/**
 * Enhanced Wix migration script v2: Import all events from the Wix CSV export.
 *
 * Improvements over v1:
 * - Uses "events" terminology consistently (not "retreats")
 * - Maps designation → eventTypeId and audience → audienceId
 * - S3 file verification with state detection
 * - Transactional, resumable migration
 * - --validate-only mode with JSON reporting
 * - Progress indicators and detailed logging
 * - Track count verification
 * - Teacher/place inference from event codes
 * - Processes latest events first
 *
 * Prerequisites:
 * - Run seed-from-csv.ts first to populate teachers, places, groups, event types, audiences
 * - Database must be migrated and accessible
 * - S3 credentials configured in .env
 *
 * Usage:
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv>
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> --dry-run
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> --validate-only
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> --limit 10
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> --skip 50
 *   bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> --resume migration-state.json
 */

import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { places } from "../db/schema/places.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventTypes } from "../db/schema/event-types.ts";
import { audiences } from "../db/schema/audiences.ts";
import {
  events,
  eventTeachers,
  eventPlaces,
  eventRetreatGroups,
} from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import {
  parseWixRow,
  parseDateRange,
  parseTeachers,
  parseOrganizations,
  parseTrackCount,
  mapLanguage,
  matchDesignationToEventType,
  matchAudienceToRecord,
  designationToGroup,
  type WixRow,
} from "./csv-parser.ts";
import { parseTrackFilename, inferSessions } from "../services/track-parser.ts";
import {
  analyzeEventS3State,
  extractS3Prefix,
  extractS3Directory,
  findTranscriptInS3,
  type S3StateReport,
} from "./s3-utils.ts";
import {
  classifyTracks,
  generateBucketTree,
  renderTree,
  type TrackClassification,
  type TreeNode,
} from "./track-deduplication.ts";
import { generateHTMLReport, type ReportData, type EventSummary } from "./html-report-generator.ts";

// ============================================================================
// CLI Arguments Parsing
// ============================================================================

interface CliArgs {
  csvPath: string;
  dryRun: boolean;
  validateOnly: boolean;
  limit: number | null;
  skip: number;
  resumeFrom: string | null;
  outputReport: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) {
    console.error(
      "Usage: bun run src/scripts/migrate-from-wix-v2.ts <path-to-csv> [options]",
    );
    console.error("Options:");
    console.error("  --dry-run          Simulate migration without database writes");
    console.error("  --validate-only    Validate data and S3 files, no migration");
    console.error("  --limit N          Process only N events");
    console.error("  --skip N           Skip first N events");
    console.error("  --resume FILE      Resume from previous state file");
    console.error("  --output FILE      Write validation report to FILE (default: migration-report.json)");
    process.exit(1);
  }

  return {
    csvPath,
    dryRun: args.includes("--dry-run"),
    validateOnly: args.includes("--validate-only"),
    limit: args.includes("--limit")
      ? parseInt(args[args.indexOf("--limit") + 1]!, 10)
      : null,
    skip: args.includes("--skip")
      ? parseInt(args[args.indexOf("--skip") + 1]!, 10)
      : 0,
    resumeFrom: args.includes("--resume")
      ? args[args.indexOf("--resume") + 1]!
      : null,
    outputReport: args.includes("--output")
      ? args[args.indexOf("--output") + 1]!
      : "migration-report.json",
  };
}

// ============================================================================
// State Management for Resumable Migration
// ============================================================================

interface MigrationState {
  processedEventCodes: string[];
  skippedEventCodes: string[];
  failedEventCodes: { code: string; error: string }[];
  lastProcessedIndex: number;
  timestamp: string;
}

function loadState(filePath: string): MigrationState | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(filePath: string, state: MigrationState): void {
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================================
// Validation Report Structure
// ============================================================================

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  category: "s3" | "mapping" | "data" | "count";
  message: string;
  eventCode: string;
  details?: any;
}

interface LegacyTrackInfo {
  eventCode: string;
  legacyTracks: string[];
  duplicates: string[];
  mainTracks: string[];
  legacyCount: number;
}

interface ValidationReport {
  totalEvents: number;
  processedEvents: number;
  validEvents: number;
  issues: ValidationIssue[];
  unmappedEventTypes: Set<string>;
  unmappedAudiences: Set<string>;
  s3States: Record<string, S3StateReport>;
  trackCountMismatches: { eventCode: string; expected: number; parsed: number }[];
  legacyTracks: LegacyTrackInfo[];  // Events with tracks going to Legacy folder
  timestamp: string;
}

// ============================================================================
// Main Execution
// ============================================================================

const cliArgs = parseArgs();

if (cliArgs.dryRun) console.log("=== DRY RUN MODE — no database writes ===\n");
if (cliArgs.validateOnly) console.log("=== VALIDATE ONLY MODE — checking data and S3 ===\n");

// Read and parse CSV
const csvContent = readFileSync(cliArgs.csvPath, "utf-8").replace(/^\uFEFF/, "");
const rawRows: Record<string, string>[] = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
});

console.log(`📄 Parsed ${rawRows.length} rows from CSV\n`);

// Load lookup tables
console.log("📦 Loading reference data...");
const allTeachers = await db.select().from(teachers);
const allPlaces = await db.select().from(places);
const allGroups = await db.select().from(retreatGroups);
const allEventTypes = await db.select().from(eventTypes);
const allAudiences = await db.select().from(audiences);
console.log(`   Teachers: ${allTeachers.length}, Places: ${allPlaces.length}, Groups: ${allGroups.length}`);
console.log(`   Event Types: ${allEventTypes.length}, Audiences: ${allAudiences.length}\n`);

// Helper functions
function findTeacher(name: string) {
  return allTeachers.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

function findPlace(location: string) {
  return allPlaces.find((p) => p.location?.toLowerCase() === location.toLowerCase());
}

function findGroup(name: string) {
  return allGroups.find(
    (g) =>
      g.nameEn?.toLowerCase() === name.toLowerCase() ||
      g.namePt?.toLowerCase() === name.toLowerCase(),
  );
}

// Infer teacher from event code (e.g., "20100308-MTR-CFR-ACM" → "MTR")
function inferTeacherFromCode(eventCode: string): typeof allTeachers[0] | null {
  const match = eventCode.match(/\d{8}-([A-Z]{2,5})-/);
  if (!match) return null;

  const abbrev = match[1]!;
  return allTeachers.find((t) => t.abbreviation?.toUpperCase() === abbrev);
}

// Infer place from event code or default to common places
function inferPlaceFromCode(eventCode: string): typeof allPlaces[0] | null {
  // Check if event code contains location hints
  if (eventCode.includes("LIS")) {
    return allPlaces.find((p) => p.location?.includes("Lisboa"));
  }
  if (eventCode.includes("PRT") || eventCode.includes("PT")) {
    return allPlaces.find((p) => p.location?.includes("Porto"));
  }
  return null;
}

// Initialize validation report
const validationReport: ValidationReport = {
  totalEvents: 0,
  processedEvents: 0,
  validEvents: 0,
  issues: [],
  unmappedEventTypes: new Set(),
  unmappedAudiences: new Set(),
  s3States: {},
  trackCountMismatches: [],
  legacyTracks: [],
  timestamp: new Date().toISOString(),
};

// Array to collect tree structures for HTML report
const bucketTrees: TreeNode[] = [];

// Array to collect events without audio tracks
const eventsWithoutTracks: Array<{ eventCode: string; title: string; s3Directory?: string | null }> = [];

// Initialize counters
let eventsCreated = 0;
let sessionsCreated = 0;
let tracksCreated = 0;
let transcriptsCreated = 0;

// Load or initialize state
const stateFile = "migration-state.json";
let migrationState: MigrationState = cliArgs.resumeFrom
  ? loadState(cliArgs.resumeFrom) ?? {
      processedEventCodes: [],
      skippedEventCodes: [],
      failedEventCodes: [],
      lastProcessedIndex: -1,
      timestamp: new Date().toISOString(),
    }
  : {
      processedEventCodes: [],
      skippedEventCodes: [],
      failedEventCodes: [],
      lastProcessedIndex: -1,
      timestamp: new Date().toISOString(),
    };

console.log("🔄 Migration state:", {
  previouslyProcessed: migrationState.processedEventCodes.length,
  previouslyFailed: migrationState.failedEventCodes.length,
});

// Parse all rows
const parsedRows = rawRows.map(parseWixRow).filter((row) => row.eventCode);

// Sort by date (latest first) - extract year from event code
parsedRows.sort((a, b) => {
  const yearA = parseInt(a.eventCode.substring(0, 4) ?? "0", 10);
  const yearB = parseInt(b.eventCode.substring(0, 4) ?? "0", 10);
  return yearB - yearA; // Descending (latest first)
});

// Apply skip and limit
const startIdx = Math.max(cliArgs.skip, migrationState.lastProcessedIndex + 1);
const rowsToProcess = cliArgs.limit
  ? parsedRows.slice(startIdx, startIdx + cliArgs.limit)
  : parsedRows.slice(startIdx);

validationReport.totalEvents = parsedRows.length;

console.log(`\n📊 Processing ${rowsToProcess.length} events (from index ${startIdx})\n`);
console.log("─".repeat(80));

// ============================================================================
// Process Each Event
// ============================================================================

for (let i = 0; i < rowsToProcess.length; i++) {
  const row = rowsToProcess[i]!;
  const globalIdx = startIdx + i;

  // Skip if already processed
  if (migrationState.processedEventCodes.includes(row.eventCode)) {
    console.log(`⏭️  [${globalIdx + 1}/${parsedRows.length}] ${row.eventCode}: Already processed, skipping`);
    continue;
  }

  console.log(`\n🔄 [${globalIdx + 1}/${parsedRows.length}] ${row.eventCode}: ${row.title || "Untitled"}`);
  validationReport.processedEvents++;

  try {
    const { startDate, endDate } = parseDateRange(row.dateRange);
    const status = row.onOff ? "published" : "draft";

    // Extract actual S3 directories from download URLs (preserving folder structure)
    const audio1Directory = row.audio1.downloadUrl
      ? extractS3Directory(row.audio1.downloadUrl)
      : null;
    const audio2Directory = row.audio2.downloadUrl
      ? extractS3Directory(row.audio2.downloadUrl)
      : null;

    // Legacy prefix for S3 validation (still uses old format)
    const s3Prefix = extractS3Prefix(row.audio1.downloadUrl);

    // Define which designations are actual event types (not retreat groups)
    // Retreat group levels (Práticas Preliminares Nível 1-4, etc.) are linked via
    // retreatGroupRetreats junction table, not via eventTypeId
    // Note: This matches EVENT_TYPE_DESIGNATIONS in seed-from-csv.ts
    const EVENT_TYPE_DESIGNATIONS = new Set([
      "Conferência",
      "Ensinamento",
      "Ensinamento Restrito",
    ]);

    // Map designation to event type ONLY if it's in the event type list
    const eventType = row.designation && EVENT_TYPE_DESIGNATIONS.has(row.designation)
      ? matchDesignationToEventType(row.designation, allEventTypes)
      : null;

    if (row.designation && EVENT_TYPE_DESIGNATIONS.has(row.designation) && !eventType) {
      validationReport.unmappedEventTypes.add(row.designation);
      validationReport.issues.push({
        severity: "warning",
        category: "mapping",
        message: `Event type not found for designation: "${row.designation}"`,
        eventCode: row.eventCode,
      });
    }

    // Map audience
    const audience = row.audience
      ? matchAudienceToRecord(row.audience, allAudiences)
      : null;

    if (row.audience && !audience) {
      validationReport.unmappedAudiences.add(row.audience);
      validationReport.issues.push({
        severity: "warning",
        category: "mapping",
        message: `Audience not found: "${row.audience}"`,
        eventCode: row.eventCode,
      });
    }

    // S3 validation (read-only, safe in all modes)
    // Note: Only reads S3 metadata, never writes
    if (s3Prefix) {
      const allTrackNames = [
        ...row.audio1.trackNames,
        ...row.audio2.trackNames,
      ];

      const s3State = await analyzeEventS3State(
        s3Prefix,
        allTrackNames,
        row.audio1.downloadUrl,
      );

      validationReport.s3States[row.eventCode] = s3State;

      if (s3State.state === "MISSING") {
        validationReport.issues.push({
          severity: "error",
          category: "s3",
          message: "No audio files found in S3 (neither extracted nor ZIP)",
          eventCode: row.eventCode,
          details: s3State,
        });
      } else if (s3State.state === "ZIP_ONLY") {
        validationReport.issues.push({
          severity: "info",
          category: "s3",
          message: "ZIP file exists but not extracted - extraction needed before playback",
          eventCode: row.eventCode,
        });
      } else if (s3State.state === "PARTIAL") {
        validationReport.issues.push({
          severity: "warning",
          category: "s3",
          message: `Partial extraction: ${s3State.actualFileCount}/${s3State.expectedTrackCount} tracks found`,
          eventCode: row.eventCode,
          details: s3State,
        });
      }
    }

    // Generate tree structure for all events with tracks
    if (row.audio1.trackNames.length > 0 || row.audio2.trackNames.length > 0) {
      const s3Dir = audio2Directory || audio1Directory;
      const tree = generateBucketTree(row.eventCode, row.audio1.trackNames, row.audio2.trackNames, s3Dir);
      bucketTrees.push(tree);
    } else {
      // Track events without any audio files
      const s3Dir = audio2Directory || audio1Directory;
      eventsWithoutTracks.push({
        eventCode: row.eventCode,
        title: row.title || "Untitled",
        s3Directory: s3Dir,
      });
    }

    // Track deduplication and Legacy folder analysis (only for events with both)
    if (row.audio1.trackNames.length > 0 && row.audio2.trackNames.length > 0) {
      const classification = classifyTracks(row.audio1.trackNames, row.audio2.trackNames);

      if (classification.legacyTracks.length > 0) {
        validationReport.legacyTracks.push({
          eventCode: row.eventCode,
          legacyTracks: classification.legacyTracks,
          duplicates: classification.duplicates,
          mainTracks: classification.mainTracks,
          legacyCount: classification.legacyTracks.length,
        });

        validationReport.issues.push({
          severity: "info",
          category: "data",
          message: `${classification.legacyTracks.length} unique tracks from audio1 will go to Legacy folder`,
          eventCode: row.eventCode,
          details: {
            legacyTracks: classification.legacyTracks,
            mainTracks: classification.mainTracks,
            duplicates: classification.duplicates,
            audio1Tracks: row.audio1.trackNames,
            audio2Tracks: row.audio2.trackNames,
          },
        });
      }
    }

    // Track count verification
    const expectedCount = parseTrackCount(row.audio1.trackCount) + parseTrackCount(row.audio2.trackCount);
    const parsedCount = row.audio1.trackNames.length + row.audio2.trackNames.length;

    if (expectedCount !== parsedCount && expectedCount > 0) {
      validationReport.trackCountMismatches.push({
        eventCode: row.eventCode,
        expected: expectedCount,
        parsed: parsedCount,
      });
      validationReport.issues.push({
        severity: "warning",
        category: "count",
        message: `Track count mismatch: expected ${expectedCount}, parsed ${parsedCount}`,
        eventCode: row.eventCode,
        details: {
          expectedCount,
          parsedCount,
          audio1: {
            expected: parseTrackCount(row.audio1.trackCount),
            tracks: row.audio1.trackNames,
          },
          audio2: {
            expected: parseTrackCount(row.audio2.trackCount),
            tracks: row.audio2.trackNames,
          },
        },
      });
    }

    // If validate-only mode, skip DB operations
    if (cliArgs.validateOnly) {
      console.log(`   ✓ Validation complete`);
      migrationState.processedEventCodes.push(row.eventCode);
      continue;
    }

    // --- Create event record ---
    if (cliArgs.dryRun) {
      console.log(`   📝 Would create event: ${row.title}`);
      console.log(`      Status: ${status}, Type: ${eventType?.nameEn ?? "none"}, Audience: ${audience?.nameEn ?? "none"}`);
      eventsCreated++;
      migrationState.processedEventCodes.push(row.eventCode);
      continue;
    }

    const [event] = await db
      .insert(events)
      .values({
        eventCode: row.eventCode,
        titlePt: row.title || null,
        titleEn: row.title || row.eventCode,
        mainThemesPt: row.mainThemes || null,
        mainThemesEn: null,
        sessionThemesEn: row.sessionThemes || null,
        sessionThemesPt: null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        eventTypeId: eventType?.id ?? null,
        audienceId: audience?.id ?? null,
        bibliography: row.bibliography || null,
        notes: row.notes || null,
        status,
        s3Prefix: s3Prefix || null,
        wixId: row.wixId || null,
      })
      .onConflictDoNothing()
      .returning();

    if (!event) {
      console.log(`   ⚠️  Already exists, skipping`);
      migrationState.skippedEventCodes.push(row.eventCode);
      continue;
    }

    eventsCreated++;
    console.log(`   ✓ Event created (ID: ${event.id})`);

    // --- Link teachers ---
    const teacherNames = parseTeachers(row.teacherName);
    if (teacherNames.length === 0) {
      // Try to infer from event code
      const inferredTeacher = inferTeacherFromCode(row.eventCode);
      if (inferredTeacher) {
        teacherNames.push(inferredTeacher.name);
        console.log(`   🔍 Inferred teacher: ${inferredTeacher.name}`);
      }
    }

    for (const tName of teacherNames) {
      const teacher = findTeacher(tName);
      if (teacher) {
        await db
          .insert(eventTeachers)
          .values({ eventId: event.id, teacherId: teacher.id, role: "teacher" })
          .onConflictDoNothing();
      } else {
        validationReport.issues.push({
          severity: "warning",
          category: "mapping",
          message: `Teacher not found: "${tName}"`,
          eventCode: row.eventCode,
        });
      }
    }

    // Link guest teacher
    if (row.guestName) {
      const guest = findTeacher(row.guestName);
      if (guest) {
        await db
          .insert(eventTeachers)
          .values({ eventId: event.id, teacherId: guest.id, role: "guest" })
          .onConflictDoNothing();
      }
    }

    // --- Link place ---
    let place = row.place ? findPlace(row.place) : null;
    if (!place) {
      place = inferPlaceFromCode(row.eventCode);
      if (place) {
        console.log(`   🔍 Inferred place: ${place.name}`);
      }
    }

    if (place) {
      await db
        .insert(eventPlaces)
        .values({ eventId: event.id, placeId: place.id })
        .onConflictDoNothing();
    } else if (row.place) {
      validationReport.issues.push({
        severity: "warning",
        category: "mapping",
        message: `Place not found: "${row.place}"`,
        eventCode: row.eventCode,
      });
    }

    // --- Link groups ---
    for (const orgName of parseOrganizations(row.organization)) {
      const group = findGroup(orgName);
      if (group) {
        await db
          .insert(eventRetreatGroups)
          .values({ eventId: event.id, retreatGroupId: group.id })
          .onConflictDoNothing();
      } else {
        validationReport.issues.push({
          severity: "warning",
          category: "mapping",
          message: `Group not found: "${orgName}"`,
          eventCode: row.eventCode,
        });
      }
    }

    // --- Link groups from designation field ---
    // Designations like "Práticas Preliminares - Nível 1" map to retreat groups
    if (row.designation && !EVENT_TYPE_DESIGNATIONS.has(row.designation)) {
      const groupInfo = designationToGroup(row.designation);
      if (groupInfo) {
        // Try to find group by Portuguese or English name
        const group = allGroups.find(
          (g) =>
            g.namePt?.toLowerCase() === groupInfo.namePt.toLowerCase() ||
            g.nameEn?.toLowerCase() === groupInfo.nameEn.toLowerCase(),
        );
        if (group) {
          await db
            .insert(eventRetreatGroups)
            .values({ eventId: event.id, retreatGroupId: group.id })
            .onConflictDoNothing();
        } else {
          validationReport.issues.push({
            severity: "warning",
            category: "mapping",
            message: `Retreat group not found for designation: "${row.designation}" (mapped to "${groupInfo.namePt}")`,
            eventCode: row.eventCode,
          });
        }
      }
    }

    // --- Create sessions and tracks from audio1 ---
    if (row.audio1.trackNames.length > 0 && audio1Directory) {
      const { s: sessionCount, t: trackCount } = await importTracks(
        event.id,
        row.audio1.trackNames,
        audio1Directory,
        false,
      );
      sessionsCreated += sessionCount;
      tracksCreated += trackCount;
      console.log(`   ✓ Created ${sessionCount} sessions, ${trackCount} tracks from ${audio1Directory}`);
    }

    // --- Create tracks from audio2 (translations) ---
    if (row.audio2.trackNames.length > 0 && audio2Directory) {
      const { t: trackCount } = await importTracks(
        event.id,
        row.audio2.trackNames,
        audio2Directory,
        true,
      );
      tracksCreated += trackCount;
      console.log(`   ✓ Created ${trackCount} translation tracks from ${audio2Directory}`);
    }

    // --- Create transcript records (event-level only) ---
    if (row.transcript1.language) {
      await createTranscript(event.id, row.transcript1, 1, audio1Directory);
      transcriptsCreated++;
    }
    if (row.transcript2.language) {
      await createTranscript(event.id, row.transcript2, 2, audio2Directory ?? audio1Directory);
      transcriptsCreated++;
    }

    migrationState.processedEventCodes.push(row.eventCode);
    migrationState.lastProcessedIndex = globalIdx;
    validationReport.validEvents++;

    // Save state periodically (every 10 events)
    if (eventsCreated % 10 === 0) {
      migrationState.timestamp = new Date().toISOString();
      saveState(stateFile, migrationState);
    }
  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
    migrationState.failedEventCodes.push({
      code: row.eventCode,
      error: err.message,
    });
    validationReport.issues.push({
      severity: "error",
      category: "data",
      message: `Migration failed: ${err.message}`,
      eventCode: row.eventCode,
    });
  }
}

// ============================================================================
// Final Summary
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("📊 MIGRATION SUMMARY");
console.log("=".repeat(80));

if (!cliArgs.validateOnly) {
  console.log(`Events created:      ${eventsCreated}`);
  console.log(`Sessions created:    ${sessionsCreated}`);
  console.log(`Tracks created:      ${tracksCreated}`);
  console.log(`Transcripts created: ${transcriptsCreated}`);
  console.log(`Skipped (existing):  ${migrationState.skippedEventCodes.length}`);
  console.log(`Failed:              ${migrationState.failedEventCodes.length}`);
}

console.log(`\nValidation Issues:   ${validationReport.issues.length}`);
console.log(`  Errors:   ${validationReport.issues.filter((i) => i.severity === "error").length}`);
console.log(`  Warnings: ${validationReport.issues.filter((i) => i.severity === "warning").length}`);
console.log(`  Info:     ${validationReport.issues.filter((i) => i.severity === "info").length}`);

if (validationReport.unmappedEventTypes.size > 0) {
  console.log(`\nUnmapped Event Types (${validationReport.unmappedEventTypes.size}):`);
  for (const et of validationReport.unmappedEventTypes) {
    console.log(`  - "${et}"`);
  }
}

if (validationReport.unmappedAudiences.size > 0) {
  console.log(`\nUnmapped Audiences (${validationReport.unmappedAudiences.size}):`);
  for (const aud of validationReport.unmappedAudiences) {
    console.log(`  - "${aud}"`);
  }
}

if (validationReport.trackCountMismatches.length > 0) {
  console.log(`\nTrack Count Mismatches: ${validationReport.trackCountMismatches.length} events`);
}

if (validationReport.legacyTracks.length > 0) {
  console.log(`\nLegacy Tracks: ${validationReport.legacyTracks.length} events will have tracks in Legacy folder`);
  const totalLegacyTracks = validationReport.legacyTracks.reduce((sum, e) => sum + e.legacyCount, 0);
  console.log(`  Total Legacy tracks: ${totalLegacyTracks}`);
}

// Generate interactive HTML report (in validation mode)
if (cliArgs.validateOnly) {
  console.log("\n🌳 Generating interactive HTML report...");

  // Calculate statistics
  const totalLegacyTracks = validationReport.legacyTracks.reduce((sum, e) => sum + e.legacyCount, 0);
  const totalMainTracks = validationReport.legacyTracks.reduce((sum, e) => sum + e.mainTracks.length, 0);
  const totalDuplicates = validationReport.legacyTracks.reduce((sum, e) => sum + e.duplicates.length, 0);

  // Build event code → S3 directory mapping
  const eventS3Directories: Record<string, string> = {};
  
  // Add from bucket trees (events with tracks)
  for (const tree of bucketTrees) {
    if (tree.s3Directory) {
      eventS3Directories[tree.name] = tree.s3Directory;
    }
  }
  
  // Add from events without tracks
  for (const evt of eventsWithoutTracks) {
    if (evt.s3Directory) {
      eventS3Directories[evt.eventCode] = evt.s3Directory;
    }
  }

  // Build events list with all information
  const eventsList: EventSummary[] = parsedRows.map(row => {
    const eventIssues = validationReport.issues.filter(issue => issue.eventCode === row.eventCode);
    const errorCount = eventIssues.filter(i => i.severity === 'error').length;
    const warningCount = eventIssues.filter(i => i.severity === 'warning').length;
    const infoCount = eventIssues.filter(i => i.severity === 'info').length;
    
    const hasAudio = row.audio1.downloadUrl !== null || row.audio2.downloadUrl !== null;
    const hasTracks = row.audio1.trackNames.length > 0 || row.audio2.trackNames.length > 0;
    
    return {
      eventCode: row.eventCode,
      title: row.title || row.eventCode,
      s3Directory: eventS3Directories[row.eventCode] || null,
      audio1Tracks: row.audio1.trackNames,
      audio2Tracks: row.audio2.trackNames,
      hasAudio,
      hasTracks,
      issues: eventIssues,
      errorCount,
      warningCount,
      infoCount,
    };
  });

  // Prepare report data
  const htmlReportData: ReportData = {
    timestamp: validationReport.timestamp,
    totalEvents: validationReport.totalEvents,
    processedEvents: validationReport.processedEvents,
    validEvents: validationReport.validEvents,
    eventsWithTracks: bucketTrees.length,
    eventsWithoutTracks,
    eventsWithLegacyTracks: validationReport.legacyTracks.length,
    totalMainTracks,
    totalLegacyTracks,
    totalDuplicates,
    trees: bucketTrees,
    legacyTracks: validationReport.legacyTracks,
    issues: validationReport.issues,
    trackCountMismatches: validationReport.trackCountMismatches,
    unmappedEventTypes: Array.from(validationReport.unmappedEventTypes),
    unmappedAudiences: Array.from(validationReport.unmappedAudiences),
    eventsList,  // All events with aggregated information
    s3Bucket: "padmakara-pt", // Production bucket (not using padmakara-pt-sample)
    s3Region: "eu-west-3",
    eventS3Directories,
  };

  // Generate and write HTML report
  const htmlContent = generateHTMLReport(htmlReportData);
  const htmlReportPath = "migration-report.html";
  writeFileSync(htmlReportPath, htmlContent, "utf-8");
  console.log(`   Interactive report: ${htmlReportPath}`);
}

// Save final state and validation report
migrationState.timestamp = new Date().toISOString();
saveState(stateFile, migrationState);

const reportData = {
  ...validationReport,
  unmappedEventTypes: Array.from(validationReport.unmappedEventTypes),
  unmappedAudiences: Array.from(validationReport.unmappedAudiences),
  migrationState,
};
writeFileSync(cliArgs.outputReport, JSON.stringify(reportData, null, 2), "utf-8");

console.log(`\n📄 Reports saved:`);
console.log(`   State: ${stateFile}`);
console.log(`   Validation: ${cliArgs.outputReport}`);
if (cliArgs.validateOnly) {
  console.log(`   Interactive HTML: migration-report.html`);
}

if (cliArgs.dryRun) console.log("\n💡 Dry run complete - no data was written to database");
if (cliArgs.validateOnly) console.log("\n💡 Validation complete - no migration performed");

console.log("=".repeat(80) + "\n");

process.exit(migrationState.failedEventCodes.length > 0 ? 1 : 0);

// ====== Helper functions ======

/**
 * Import tracks for an event, inferring sessions from filenames.
 * Returns counts of sessions and tracks created.
 */
async function importTracks(
  eventId: number,
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
        eventId,
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
      const s3Key = s3Prefix ? `${s3Prefix}/${track.originalFilename}` : null;

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
 * Create a transcript record from Wix data (event-level only).
 *
 * @param eventId - The event ID to link transcript to
 * @param data - Transcript data from CSV
 * @param index - Transcript index (1 or 2)
 * @param audioDirectory - Audio directory path for intelligent PDF search
 */
async function createTranscript(
  eventId: number,
  data: WixRow["transcript1"],
  index: number,
  audioDirectory: string | null,
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

  // If no PDF URL in CSV and we have audio directory, search for PDF in common locations
  if (!s3Key && audioDirectory && !cliArgs.validateOnly && !cliArgs.dryRun) {
    try {
      s3Key = await findTranscriptInS3(audioDirectory, lang);
      if (s3Key) {
        console.log(`   🔍 Found transcript PDF: ${s3Key}`);
      }
    } catch (err) {
      console.log(`   ⚠️  Could not search for transcript: ${(err as Error).message}`);
    }
  }

  await db
    .insert(transcripts)
    .values({
      eventId,
      language: lang,
      s3Key,
      pageCount,
      status: data.status || "available",
    })
    .onConflictDoNothing();
}
