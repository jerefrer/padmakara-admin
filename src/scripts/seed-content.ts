/**
 * Phase 4: Seed content metadata into PostgreSQL.
 *
 * Reads rosetta-stone.json (232 events) and s3-inventory.json (file manifests),
 * then inserts events, junction tables, sessions, tracks, and transcripts
 * into the database in dependency order, wrapped in a single transaction.
 *
 * Usage:
 *   bun run src/scripts/seed-content.ts                      # full seed
 *   bun run src/scripts/seed-content.ts --dry-run             # inspect only
 *   bun run src/scripts/seed-content.ts --events CODE1,CODE2  # subset
 */

import path from "path";
import { readFileSync } from "fs";
import { db } from "../db/index.ts";
import {
  events,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
} from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { eventFiles } from "../db/schema/event-files.ts";
import { teachers } from "../db/schema/teachers.ts";
import { places } from "../db/schema/places.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventTypes } from "../db/schema/event-types.ts";
import { audiences } from "../db/schema/audiences.ts";
import { translateTitleToEnglish } from "../utils/translate-title.ts";
import {
  parseDateRange,
  parseTeachers,
  mapLanguage,
  designationToGroup,
  matchDesignationToEventType,
  matchAudienceToRecord,
} from "./csv-parser.ts";
import { parseTrackFilename, inferSessions } from "../services/track-parser.ts";

// ============================================================================
// Types (JSON structures)
// ============================================================================

interface RosettaEvent {
  canonicalCode: string;
  s3Path: string;
  s3FolderName: string;
  matchStatus: "matched" | "s3_only";
  targetPath: string;
  inferredMetadata?: {
    title?: string;
    teacher?: string;
    type?: string;
    place?: string;
    date?: string;
    notes?: string;
  };
  csvData: {
    eventCode?: string;
    eventTitle?: string;
    teacherName?: string;
    placeTeaching?: string;
    dateRange?: string;
    originalDesignation?: string;
    currentDesignation?: string;
    mainThemes?: string;
    sessionThemes?: string;
    guestName?: string;
    audio1Language?: string;
    audio2Language?: string;
    transcript1Language?: string;
    transcript1Pages?: string;
    transcript2Language?: string;
    transcript2Pages?: string;
    distributionAudience?: string;
    notes?: string;
    onOff?: string;
  } | null;
}

interface ZipEntry {
  name: string;
  uncompressedSize: number;
  compressedSize?: number;
  type: string;
}

interface InventoryFile {
  relativePath: string;
  s3Key: string;
  type: string;
  size: number;
  category: string;
  language?: string;
  zipContents?: ZipEntry[] | null;
}

interface InventoryEvent {
  canonicalCode: string;
  s3Path: string;
  matchStatus: string;
  files: InventoryFile[];
  migrationPlan: {
    duplicateGroups?: Array<{
      filename: string;
      occurrences: Array<{
        source: string;
        category: string;
        fullPath: string;
        size: number;
      }>;
    }> | null;
    totalAudioTracks: number;
    totalTranscripts: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Designations that map to retreat groups (not event types) */
const GROUP_DESIGNATIONS = new Set([
  "Śamatha",
  "Śamatha + Introdução à Via",
  "Treino da Mente 1",
  "Treino da Mente 2",
  "Treino da Mente (Pr. dos Bodhisattvas)",
  "Práticas Preliminares - Nível 1",
  "Práticas Preliminares - Nível 2",
  "Práticas Preliminares - Nível 3",
  "Práticas Preliminares - Nível 4",
  "Prática de Buda Śākyamuni",
  "Práticas dos Bodhisattvas",
]);

/** Language tokens from CSV language fields to ISO abbreviations */
const LANGUAGE_TOKENS: Record<string, string> = {
  "Inglês": "EN",
  "Português": "PT",
  "Tibetano": "TIB",
  "Francês": "FR",
  "Inglês | Português": "EN",
  "Português | Inglês": "PT",
};

const MEDIA_EXTENSIONS = new Set([
  // Audio
  "mp3", "wav", "m4a", "flac", "ogg", "aac", "wma",
  // Video
  "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "mpg", "mpeg",
]);

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
const SUBTITLE_EXTENSIONS = new Set(["vtt", "sbv", "srt"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "txt", "rtf"]);
const DESIGN_EXTENSIONS = new Set(["indd", "psd", "ai"]);

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { dryRun: boolean; eventFilter: Set<string> | null } {
  const args = process.argv.slice(2);
  let dryRun = false;
  let eventFilter: Set<string> | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--events" && i + 1 < args.length) {
      const codes = args[i + 1]!.split(",").map((c) => c.trim()).filter(Boolean);
      eventFilter = new Set(codes);
      i++;
    } else if (arg.startsWith("--events=")) {
      const codes = arg.slice("--events=".length).split(",").map((c) => c.trim()).filter(Boolean);
      eventFilter = new Set(codes);
    }
  }

  return { dryRun, eventFilter };
}

// ============================================================================
// JSON Loading
// ============================================================================

function loadJSON<T>(filePath: string): T {
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

// ============================================================================
// Reference Data Loading
// ============================================================================

interface RefData {
  teachersByName: Map<string, number>;
  teachersByAbbrev: Map<string, number>;
  placesByName: Map<string, number>;
  placesByAbbrev: Map<string, number>;
  groupsByPt: Map<string, number>;
  groupsByEn: Map<string, number>;
  groupsByAbbrev: Map<string, number>;
  eventTypeRecords: Array<{ id: number; namePt: string | null; nameEn: string }>;
  eventTypesByAbbrev: Map<string, number>;
  audienceRecords: Array<{ id: number; namePt: string | null; nameEn: string }>;
}

async function loadRefData(): Promise<RefData> {
  const allTeachers = await db.select().from(teachers);
  const allPlaces = await db.select().from(places);
  const allGroups = await db.select().from(retreatGroups);
  const allEventTypes = await db.select().from(eventTypes);
  const allAudiences = await db.select().from(audiences);

  if (allTeachers.length === 0) {
    console.error("No teachers found in DB. Run seed-from-csv.ts first.");
    process.exit(1);
  }
  if (allPlaces.length === 0) {
    console.error("No places found in DB. Run seed-from-csv.ts first.");
    process.exit(1);
  }
  if (allGroups.length === 0) {
    console.error("No retreat groups found in DB. Run seed-from-csv.ts first.");
    process.exit(1);
  }

  const teachersByName = new Map<string, number>();
  const teachersByAbbrev = new Map<string, number>();
  for (const t of allTeachers) {
    teachersByName.set(t.name.toLowerCase(), t.id);
    teachersByAbbrev.set(t.abbreviation.toLowerCase(), t.id);
    // Also index aliases so TPWR → PWR's teacher id, HHDL → DL's teacher id, etc.
    if (t.aliases) {
      for (const alias of t.aliases) {
        teachersByAbbrev.set(alias.toLowerCase(), t.id);
      }
    }
  }

  const placesByName = new Map<string, number>();
  const placesByAbbrev = new Map<string, number>();
  for (const p of allPlaces) {
    placesByName.set(p.name.toLowerCase(), p.id);
    if (p.abbreviation) {
      placesByAbbrev.set(p.abbreviation.toLowerCase(), p.id);
    }
    // Also index by location substring (place name is short form)
    if (p.location) {
      placesByName.set(p.location.toLowerCase(), p.id);
    }
  }

  const groupsByPt = new Map<string, number>();
  const groupsByEn = new Map<string, number>();
  const groupsByAbbrev = new Map<string, number>();
  for (const g of allGroups) {
    if (g.namePt) groupsByPt.set(g.namePt.toLowerCase(), g.id);
    groupsByEn.set(g.nameEn.toLowerCase(), g.id);
    if (g.abbreviation) groupsByAbbrev.set(g.abbreviation.toUpperCase(), g.id);
  }

  return {
    teachersByName,
    teachersByAbbrev,
    placesByName,
    placesByAbbrev,
    groupsByPt,
    groupsByEn,
    groupsByAbbrev,
    eventTypeRecords: allEventTypes.map((et) => ({
      id: et.id,
      namePt: et.namePt,
      nameEn: et.nameEn,
    })),
    eventTypesByAbbrev: new Map(allEventTypes.map((et) => [et.abbreviation.toUpperCase(), et.id])),
    audienceRecords: allAudiences.map((a) => ({
      id: a.id,
      namePt: a.namePt,
      nameEn: a.nameEn,
    })),
  };
}

// ============================================================================
// Teacher/Place Resolution Helpers
// ============================================================================

function resolveTeacherIds(
  teacherNames: string[],
  ref: RefData,
): number[] {
  const ids: number[] = [];
  for (const name of teacherNames) {
    const id =
      ref.teachersByName.get(name.toLowerCase()) ??
      ref.teachersByAbbrev.get(name.toLowerCase());
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

function resolvePlaceId(
  placeString: string,
  ref: RefData,
): number | null {
  if (!placeString) return null;

  // Try full string match (including location)
  const byFull = ref.placesByName.get(placeString.toLowerCase());
  if (byFull) return byFull;

  // Try short name (first part before comma)
  const shortName = placeString.split(",")[0]!.trim().toLowerCase();
  const byShort = ref.placesByName.get(shortName);
  if (byShort) return byShort;

  // Try abbreviation
  const byAbbrev = ref.placesByAbbrev.get(shortName);
  if (byAbbrev) return byAbbrev;

  return null;
}

function resolveGroupId(
  designation: string,
  ref: RefData,
): number | null {
  if (!designation) return null;

  // Only group designations map to retreat groups
  if (!GROUP_DESIGNATIONS.has(designation)) return null;

  const groupNames = designationToGroup(designation);
  if (!groupNames) return null;

  return (
    ref.groupsByPt.get(groupNames.namePt.toLowerCase()) ??
    ref.groupsByEn.get(groupNames.nameEn.toLowerCase()) ??
    null
  );
}

function resolveEventTypeId(
  designation: string,
  ref: RefData,
): number | null {
  if (!designation) return null;

  // Group designations are not event types, but "Parallel Retreats" event type
  // applies to events whose designation is a group (multi-group retreat scenario).
  // For now, only map non-group designations to event types.
  if (GROUP_DESIGNATIONS.has(designation)) {
    // For group-based designations, use "Parallel Retreats" if the designation
    // does not match any event type directly.
    const match = matchDesignationToEventType(designation, ref.eventTypeRecords);
    if (match) return match.id;
    return null;
  }

  const match = matchDesignationToEventType(designation, ref.eventTypeRecords);
  return match?.id ?? null;
}

function resolveAudienceId(
  audienceStr: string,
  ref: RefData,
): number | null {
  if (!audienceStr) return null;
  const match = matchAudienceToRecord(audienceStr, ref.audienceRecords);
  return match?.id ?? null;
}

// ============================================================================
// Duplicate / Rename Map Builder
// ============================================================================

/**
 * Build a rename map for duplicate tracks that have different sizes between
 * audio1 and audio2. These tracks were renamed during Phase 3 migration
 * by appending the language token to avoid filename collisions.
 *
 * Returns:
 *  - renameMap: originalBasename -> renamedBasename for audio2 tracks
 *  - exactDupes: Set of basenames that are exact duplicates (same size)
 */
function buildDuplicateMaps(
  inventoryEvent: InventoryEvent,
): { renameMap: Map<string, string>; exactDupes: Set<string> } {
  const renameMap = new Map<string, string>();
  const exactDupes = new Set<string>();

  const dupeGroups = inventoryEvent.migrationPlan.duplicateGroups;
  if (!dupeGroups || dupeGroups.length === 0) {
    return { renameMap, exactDupes };
  }

  for (const group of dupeGroups) {
    if (group.occurrences.length < 2) continue;

    const audio1Occ = group.occurrences.find((o) => o.category === "audio1");
    const audio2Occ = group.occurrences.find((o) => o.category === "audio2");

    if (!audio1Occ || !audio2Occ) continue;

    if (audio1Occ.size === audio2Occ.size) {
      // Exact duplicate: audio2 copy was skipped during migration
      exactDupes.add(group.filename);
    } else {
      // Different sizes: audio2 was renamed during Phase 3
      // Get the audio2 language from the inventory file
      const audio2File = inventoryEvent.files.find(
        (f) => f.category === "audio2",
      );
      const langStr = audio2File?.language ?? "Português";
      const langToken = LANGUAGE_TOKENS[langStr] ?? "PT";

      const basename = group.filename;
      const ext = path.extname(basename);
      const stem = basename.slice(0, -ext.length);
      const renamed = `${stem}_${langToken}${ext}`;

      renameMap.set(basename, renamed);
    }
  }

  return { renameMap, exactDupes };
}

// ============================================================================
// Audio Track Extraction from Inventory
// ============================================================================

interface ExtractedTrack {
  basename: string;
  s3Key: string;
  category: string;
  size: number;
  isTranslation: boolean;
  isAudio2: boolean;
}

function isMediaFilename(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (lower.startsWith(".ds_store") || lower === "thumbs.db" || lower.startsWith("._")) {
    return false;
  }
  if (lower.includes("__macosx")) return false;
  const ext = lower.split(".").pop() ?? "";
  return MEDIA_EXTENSIONS.has(ext);
}

/**
 * Extract all media tracks (audio & video) for an event from the s3-inventory.
 * Handles:
 * - zipContents entries (most common: media is inside ZIPs)
 * - loose media files (rare: already extracted)
 * - Deduplication: skip exact duplicate audio2 tracks
 * - Renaming: apply rename map for different-size audio2 tracks
 */
function extractAudioTracks(
  inventoryEvent: InventoryEvent,
  eventCode: string,
  renameMap: Map<string, string>,
  exactDupes: Set<string>,
): ExtractedTrack[] {
  const tracks: ExtractedTrack[] = [];
  const seenBasenames = new Set<string>();

  for (const file of inventoryEvent.files) {
    const isAudio1 = file.category === "audio1";
    const isAudio2 = file.category === "audio2";

    if (!isAudio1 && !isAudio2) continue;

    if (file.zipContents && file.zipContents.length > 0) {
      // Extract tracks from ZIP contents
      for (const entry of file.zipContents) {
        // entry.name can be "subdir/track.mp3" - we want the basename
        const basename = entry.name.split("/").pop() ?? entry.name;

        if (!isMediaFilename(basename)) continue;

        const lowerBasename = basename.toLowerCase();

        if (isAudio2) {
          // Check if this is an exact duplicate that was skipped during migration
          if (exactDupes.has(lowerBasename)) continue;

          // Check if this needs renaming (different size in both audio folders)
          const renamed = renameMap.get(lowerBasename);
          const finalBasename = renamed ?? basename;
          const finalLower = finalBasename.toLowerCase();

          if (seenBasenames.has(finalLower)) continue;
          seenBasenames.add(finalLower);

          tracks.push({
            basename: finalBasename,
            s3Key: `events/${eventCode}/audio/${finalBasename}`,
            category: "audio2",
            size: entry.uncompressedSize,
            isTranslation: true,
            isAudio2: true,
          });
        } else {
          // audio1 track
          if (seenBasenames.has(lowerBasename)) continue;
          seenBasenames.add(lowerBasename);

          tracks.push({
            basename,
            s3Key: `events/${eventCode}/audio/${basename}`,
            category: "audio1",
            size: entry.uncompressedSize,
            isTranslation: false,
            isAudio2: false,
          });
        }
      }
    } else if (isMediaFilename(file.relativePath.split("/").pop() ?? "")) {
      // Loose audio file (not in a ZIP)
      const basename = file.relativePath.split("/").pop()!;
      const lowerBasename = basename.toLowerCase();

      if (isAudio2 && exactDupes.has(lowerBasename)) continue;

      if (seenBasenames.has(lowerBasename)) continue;
      seenBasenames.add(lowerBasename);

      tracks.push({
        basename,
        s3Key: `events/${eventCode}/audio/${basename}`,
        category: isAudio2 ? "audio2" : "audio1",
        size: file.size,
        isTranslation: isAudio2,
        isAudio2,
      });
    }
  }

  return tracks;
}

// ============================================================================
// Transcript Extraction from Inventory
// ============================================================================

interface ExtractedTranscript {
  basename: string;
  s3Key: string;
  size: number;
  language: string;
}

function extractTranscripts(
  inventoryEvent: InventoryEvent,
  rosettaEvent: RosettaEvent,
  eventCode: string,
): ExtractedTranscript[] {
  const result: ExtractedTranscript[] = [];

  for (const file of inventoryEvent.files) {
    if (file.category !== "transcript" && file.category !== "transcripts") continue;
    if (file.type !== ".pdf") continue;

    const basename = file.relativePath.split("/").pop()!;

    // Determine language from CSV data or file language field
    let lang = "pt"; // default
    if (rosettaEvent.csvData?.transcript1Language) {
      lang = mapLanguage(rosettaEvent.csvData.transcript1Language);
    } else if (file.language) {
      lang = mapLanguage(file.language);
    }

    result.push({
      basename,
      s3Key: `events/${eventCode}/transcripts/${basename}`,
      size: file.size,
      language: lang,
    });
  }

  return result;
}

/**
 * Extract other files (images, subtitles, documents, etc.) from the s3-inventory.
 */
interface ExtractedEventFile {
  basename: string;
  s3Key: string;
  size: number;
  fileType: string; // image, subtitle, document, design, other
  extension: string;
  language: string | null;
}

function getFileTypeCategory(extension: string): string {
  const ext = extension.toLowerCase().replace(".", "");
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (DESIGN_EXTENSIONS.has(ext)) return "design";
  return "other";
}

function extractEventFiles(
  inventoryEvent: InventoryEvent,
  eventCode: string,
): ExtractedEventFile[] {
  const result: ExtractedEventFile[] = [];

  for (const file of inventoryEvent.files) {
    const ext = file.type.toLowerCase();

    // Skip media files (handled by tracks table)
    if (MEDIA_EXTENSIONS.has(ext.replace(".", ""))) continue;

    // Skip PDFs (handled by transcripts table)
    if (ext === ".pdf") continue;

    // Skip system files and zips
    if (ext === ".zip" || ext === ".db" || ext === "" || !ext) continue;

    const basename = file.relativePath.split("/").pop()!;
    const fileType = getFileTypeCategory(ext);

    // Determine language if available
    let lang: string | null = null;
    if (file.language) {
      lang = mapLanguage(file.language);
    }

    // Check zipContents for nested files
    if (file.zipContents) {
      for (const entry of file.zipContents) {
        const entryBasename = entry.name.split("/").pop() ?? "";
        const entryExt = entryBasename.split(".").pop()?.toLowerCase() ?? "";

        // Skip media and PDFs
        if (MEDIA_EXTENSIONS.has(entryExt) || entryExt === "pdf") continue;
        if (!entryExt || entryExt === "zip" || entryExt === "db") continue;

        const entryFileType = getFileTypeCategory(`.${entryExt}`);

        result.push({
          basename: entryBasename,
          s3Key: `events/${eventCode}/${entryFileType}/${entryBasename}`,
          size: entry.uncompressedSize,
          fileType: entryFileType,
          extension: `.${entryExt}`,
          language: lang,
        });
      }
    } else {
      // Loose file
      result.push({
        basename,
        s3Key: `events/${eventCode}/${fileType}/${basename}`,
        size: file.size,
        fileType,
        extension: ext,
        language: lang,
      });
    }
  }

  return result;
}

// ============================================================================
// S3-Only Event Metadata Extraction
// ============================================================================

/**
 * Parse canonical code to extract date, teacher abbreviations, and place abbreviation.
 * Format: "2006-11-20-JKR-CFR-UBP" or "20061120-JKR-CFR-UBP"
 */
/** Known retreat group abbreviations (from event codes) */
const KNOWN_GROUP_ABBREVS: Record<string, string> = {
  SHA: "SHA", "SHA-IV": "SHA-IV",
  PBS: "PBS", PBD: "PBD",
  TM: "TM", TM1: "TM1", TM2: "TM2",
  PP1: "PP1", PP2: "PP2", PP3: "PP3", PP4: "PP4",
  RP1: "PP1", // RP1 is old abbreviation for PP1
};

/** Place abbreviation aliases */
const PLACE_ALIASES: Record<string, string> = {
  ZOM: "ZOOM",  // ZOM in event codes → ZOOM abbreviation
  VID: "ZOOM",  // VID → Online/ZOOM
};

function parseCanonicalCode(code: string): {
  date: string | null;
  endDate: string | null;
  teacherAbbrevs: string[];
  placeAbbrev: string | null;
  groupAbbrev: string | null;
  eventTypeAbbrev: string | null;
} {
  // Known teacher abbreviations (from the CSV parser abbrev map)
  const KNOWN_TEACHER_ABBREVS = new Set([
    "JKR", "PWR", "RR", "KPS", "MTR", "KNP", "DKY", "SRR", "KTR",
    "CK", "TMR", "ST", "YMR", "CNR", "DL", "SDL", "SSDL",
    "SST", "CGI", "HHST", "TRR", "WF",
    // Aliases
    "TPWR", "HHDL",
    // Unknown teachers (abbreviations found in tracks)
    "DKR", "SSR", "TSU", "JL", "HHSS", "JKT", "DLP",
  ]);
  // Known event type abbreviations (non-group types)
  const KNOWN_TYPE_ABBREVS = new Set([
    "ENS", "CFR", "ERT", "LNG", "JC", "LPT", "PRT", "RET",
  ]);

  // Try to extract date
  let dateStr: string | null = null;
  let endDateStr: string | null = null;
  let remaining = code;

  // Strip pipe-separated multi-month prefixes: "200402|03|04-..." → take first month
  const pipeMatch = code.match(/^(\d{4})(\d{2})(?:\|\d{2})+(?:-(.+))?$/);
  if (pipeMatch) {
    dateStr = `${pipeMatch[1]}-${pipeMatch[2]}-01`;
    remaining = pipeMatch[3] ?? "";
  }

  if (!dateStr) {
    // ISO date at start: 2006-11-20-... with optional end day: 2004-07-24_27-...
    const isoMatch = code.match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{2}))?-(.+)/);
    if (isoMatch) {
      dateStr = isoMatch[1]!;
      if (isoMatch[2]) {
        const [y, m] = dateStr.split("-");
        endDateStr = `${y}-${m}-${isoMatch[2]}`;
      }
      remaining = isoMatch[3]!;
    }
  }

  if (!dateStr) {
    // Compact full date: 20061120-... with optional end day: 20171114_20-...
    const compactMatch = code.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2}))?-(.+)/);
    if (compactMatch) {
      dateStr = `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
      if (compactMatch[4]) {
        endDateStr = `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[4]}`;
      }
      remaining = compactMatch[5]!;
    }
  }

  if (!dateStr) {
    // Partial date (year-month only): 200405-... or 202005-...
    const partialMatch = code.match(/^(\d{4})(\d{2})-(.+)/);
    if (partialMatch) {
      const month = parseInt(partialMatch[2]!, 10);
      if (month >= 1 && month <= 12) {
        dateStr = `${partialMatch[1]}-${partialMatch[2]}-01`;
        remaining = partialMatch[3]!;
      }
    }
  }

  if (!dateStr) {
    // ISO partial date: 2004-04-JKR-...
    const isoPartialMatch = code.match(/^(\d{4}-\d{2})-(.+)/);
    if (isoPartialMatch) {
      dateStr = `${isoPartialMatch[1]}-01`;
      remaining = isoPartialMatch[2]!;
    }
  }

  const parts = remaining.split("-").filter(Boolean);
  const teacherAbbrevs: string[] = [];
  let placeAbbrev: string | null = null;
  let groupAbbrev: string | null = null;
  let eventTypeAbbrev: string | null = null;

  for (const part of parts) {
    const upper = part.toUpperCase();
    // Check for known teacher
    if (KNOWN_TEACHER_ABBREVS.has(upper)) {
      teacherAbbrevs.push(upper);
    }
    // Check for retreat group abbreviation
    else if (upper in KNOWN_GROUP_ABBREVS) {
      groupAbbrev = KNOWN_GROUP_ABBREVS[upper]!;
    }
    // Check for event type — capture it
    else if (KNOWN_TYPE_ABBREVS.has(upper)) {
      eventTypeAbbrev = upper;
    }
    // Check for special tokens to skip
    else if (["Todos", "TODOS", "VAR", "WFL", "STA"].includes(part)) {
      continue;
    }
    // Otherwise, likely a place
    else {
      const aliased = PLACE_ALIASES[upper];
      placeAbbrev = aliased ?? upper;
    }
  }

  // If a group abbreviation was found, the event type is implicitly "Parallel Retreats" (RET)
  if (groupAbbrev && !eventTypeAbbrev) {
    eventTypeAbbrev = "RET";
  }

  return { date: dateStr, endDate: endDateStr, teacherAbbrevs, placeAbbrev, groupAbbrev, eventTypeAbbrev };
}

// ============================================================================
// Main Seeding Logic
// ============================================================================

/** Fix dates with day=00 (month-only precision from CSV) → use day 01 */
function sanitizeDate(date: string | null): string | null {
  if (!date) return null;
  return date.replace(/-00$/, "-01");
}

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

/** Convert "April 17" → ISO date using event year, or pass through ISO dates */
function toISODate(date: string | null, eventYear: string | null): string | null {
  if (!date) return null;
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  // "Month DD" format from parenthetical dates
  const match = date.match(/^(\w+)\s+(\d{1,2})$/);
  if (match) {
    const monthNum = MONTH_MAP[match[1]!.toLowerCase()];
    if (monthNum && eventYear) {
      const day = match[2]!.padStart(2, "0");
      return `${eventYear}-${monthNum}-${day}`;
    }
  }
  return null; // Unrecognized format
}

interface SeedStats {
  eventsInserted: number;
  eventsSkipped: number;
  sessionsInserted: number;
  tracksInserted: number;
  transcriptsInserted: number;
  eventFilesInserted: number;
  junctionTeachers: number;
  junctionPlaces: number;
  junctionGroups: number;
  errors: string[];
}

async function seedEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  rosettaEvent: RosettaEvent,
  inventoryEvent: InventoryEvent | undefined,
  ref: RefData,
  stats: SeedStats,
  dryRun: boolean,
): Promise<void> {
  const code = rosettaEvent.canonicalCode;
  const csv = rosettaEvent.csvData;
  const isMatched = rosettaEvent.matchStatus === "matched" && csv != null;

  // ---- Build event record ----
  let titlePt: string;
  let titleEn: string;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let eventTypeId: number | null = null;
  let audienceId: number | null = null;
  let mainThemesPt: string | null = null;
  let sessionThemesPt: string | null = null;
  let notes: string | null = null;
  let bibliography: string | null = null;
  const teacherIds: number[] = [];
  let placeId: number | null = null;
  let groupId: number | null = null;

  if (isMatched && csv) {
    titlePt = csv.eventTitle || code;
    titleEn = translateTitleToEnglish(csv.eventTitle || code);

    const dateResult = parseDateRange(csv.dateRange || "");
    startDate = sanitizeDate(dateResult.startDate);
    endDate = sanitizeDate(dateResult.endDate);

    // Fall back to date from event code if CSV has no date
    if (!startDate) {
      const codeParsed = parseCanonicalCode(code);
      if (codeParsed.date) {
        startDate = sanitizeDate(codeParsed.date);
        endDate = sanitizeDate(codeParsed.endDate ?? codeParsed.date);
      }
    }

    if (csv.currentDesignation) {
      eventTypeId = resolveEventTypeId(csv.currentDesignation, ref);
      groupId = resolveGroupId(csv.currentDesignation, ref);
    }

    // Fall back to event code for group and event type if designation didn't resolve
    if (!groupId || !eventTypeId) {
      const codeParsed2 = parseCanonicalCode(code);
      if (!groupId && codeParsed2.groupAbbrev) {
        groupId = ref.groupsByAbbrev.get(codeParsed2.groupAbbrev.toUpperCase()) ?? null;
      }
      if (!eventTypeId && codeParsed2.eventTypeAbbrev) {
        eventTypeId = ref.eventTypesByAbbrev.get(codeParsed2.eventTypeAbbrev.toUpperCase()) ?? null;
      }
    }

    if (csv.distributionAudience) {
      audienceId = resolveAudienceId(csv.distributionAudience, ref);
    }

    if (csv.teacherName) {
      const names = parseTeachers(csv.teacherName);
      teacherIds.push(...resolveTeacherIds(names, ref));
    }
    if (csv.guestName) {
      teacherIds.push(...resolveTeacherIds([csv.guestName], ref));
    }

    if (csv.placeTeaching) {
      placeId = resolvePlaceId(csv.placeTeaching, ref);
    }

    mainThemesPt = csv.mainThemes || null;
    sessionThemesPt = csv.sessionThemes || null;
    notes = csv.notes || null;
  } else {
    // S3-only event: parse code for metadata
    titlePt = code;
    titleEn = translateTitleToEnglish(code);

    const parsed = parseCanonicalCode(code);
    if (parsed.date) {
      startDate = parsed.date;
      endDate = parsed.date;
    }

    // Resolve teachers from abbreviations
    for (const abbrev of parsed.teacherAbbrevs) {
      const tId = ref.teachersByAbbrev.get(abbrev.toLowerCase());
      if (tId) teacherIds.push(tId);
    }

    // Resolve place from abbreviation
    if (parsed.placeAbbrev) {
      placeId = ref.placesByAbbrev.get(parsed.placeAbbrev.toLowerCase()) ?? null;
    }

    // Resolve group from event code abbreviation
    if (parsed.groupAbbrev) {
      groupId = ref.groupsByAbbrev.get(parsed.groupAbbrev.toUpperCase()) ?? null;
    }

    // Resolve event type from event code abbreviation
    if (parsed.eventTypeAbbrev) {
      eventTypeId = ref.eventTypesByAbbrev.get(parsed.eventTypeAbbrev.toUpperCase()) ?? null;
    }

    // Use inferred metadata if available
    if (rosettaEvent.inferredMetadata) {
      const inferred = rosettaEvent.inferredMetadata;
      if (inferred.title) {
        titlePt = inferred.title;
        titleEn = translateTitleToEnglish(inferred.title);
      }
      if (inferred.date && !startDate) {
        startDate = inferred.date;
        endDate = inferred.date;
      }
    }
  }

  if (dryRun) {
    const audioTracks = inventoryEvent
      ? extractAudioTracks(inventoryEvent, code, new Map(), new Set())
      : [];
    const parsedTracks = audioTracks.map((at) => parseTrackFilename(at.basename));
    const inferredSessions = parsedTracks.length > 0 ? inferSessions(parsedTracks) : [];
    const transcriptCount =
      inventoryEvent && rosettaEvent
        ? extractTranscripts(inventoryEvent, rosettaEvent, code).length
        : 0;

    console.log(
      `  [DRY] ${code}: "${titlePt}" | ${startDate ?? "no date"} | ` +
        `${teacherIds.length} teachers | ${inferredSessions.length} sessions | ` +
        `${audioTracks.length} tracks | ${transcriptCount} transcripts | ` +
        `${isMatched ? "matched" : "s3_only"}`,
    );
    stats.eventsInserted++;
    stats.sessionsInserted += inferredSessions.length;
    stats.tracksInserted += audioTracks.length;
    stats.transcriptsInserted += transcriptCount;
    return;
  }

  // ---- Insert event ----
  const [inserted] = await tx
    .insert(events)
    .values({
      eventCode: code,
      titleEn,
      titlePt,
      startDate,
      endDate,
      eventTypeId,
      audienceId,
      mainThemesPt,
      mainThemesEn: mainThemesPt, // Only Portuguese available
      sessionThemesPt,
      sessionThemesEn: sessionThemesPt,
      notes,
      bibliography,
      status: "published",
      s3Prefix: `events/${code}/`,
    })
    .onConflictDoNothing()
    .returning({ id: events.id });

  if (!inserted) {
    // Already exists (conflict on event_code)
    stats.eventsSkipped++;
    console.log(`  [SKIP] ${code}: already exists`);
    return;
  }

  const eventId = inserted.id;
  stats.eventsInserted++;

  // ---- Junction: event <-> teachers ----
  const uniqueTeacherIds = [...new Set(teacherIds)];
  for (const tId of uniqueTeacherIds) {
    await tx
      .insert(eventTeachers)
      .values({ eventId, teacherId: tId, role: "teacher" })
      .onConflictDoNothing();
    stats.junctionTeachers++;
  }

  // ---- Junction: event <-> place ----
  if (placeId) {
    await tx
      .insert(eventPlaces)
      .values({ eventId, placeId })
      .onConflictDoNothing();
    stats.junctionPlaces++;
  }

  // ---- Junction: event <-> retreat group ----
  if (groupId) {
    await tx
      .insert(eventRetreatGroups)
      .values({ eventId, retreatGroupId: groupId })
      .onConflictDoNothing();
    stats.junctionGroups++;
  }

  // ---- Sessions, Tracks, Transcripts (need inventory) ----
  if (!inventoryEvent) {
    console.log(`  [WARN] ${code}: no inventory data, skipping tracks/sessions`);
    return;
  }

  const { renameMap, exactDupes } = buildDuplicateMaps(inventoryEvent);

  // ---- Extract and insert tracks ----
  const audioTracks = extractAudioTracks(inventoryEvent, code, renameMap, exactDupes);

  if (audioTracks.length === 0) {
    console.log(`  [INFO] ${code}: no audio tracks found`);
  } else {
    // Parse filenames and infer sessions
    const parsedTracks = audioTracks.map((at) => {
      const parsed = parseTrackFilename(at.basename);
      // Override isTranslation based on audio2 category
      if (at.isTranslation && !parsed.isTranslation) {
        parsed.isTranslation = true;
        // Set languages for audio2 translation tracks unless already multi-language
        if (parsed.languages.length === 1 && parsed.languages[0] === "en") {
          const langField = csv?.audio2Language;
          const lang = langField ? mapLanguage(langField) : "pt";
          parsed.languages = [lang];
          parsed.originalLanguage = lang; // track's own primary language
        }
      }
      return { parsed, extracted: at };
    });

    const inferredSessions = inferSessions(parsedTracks.map((pt) => pt.parsed));

    // Fix 5: Sequential track numbering fallback when numbers are funky
    for (const sess of inferredSessions) {
      const trackNums = sess.tracks.map((t) => t.trackNumber);
      const hasFunkyNumbers =
        // All zeros (date-prefixed files that couldn't extract a number)
        trackNums.every((n) => n === 0) ||
        // Any number looks like a date (>= 19000101)
        trackNums.some((n) => n >= 19000101) ||
        // Duplicate non-zero track numbers within the same language
        (() => {
          const byLang = new Map<string, Set<number>>();
          for (const t of sess.tracks) {
            if (t.trackNumber === 0) continue;
            const set = byLang.get(t.originalLanguage) ?? new Set();
            if (set.has(t.trackNumber)) return true;
            set.add(t.trackNumber);
            byLang.set(t.originalLanguage, set);
          }
          return false;
        })();

      if (hasFunkyNumbers) {
        // Renumber sequentially: originals first, then translations
        const originals = sess.tracks.filter((t) => !t.isTranslation);
        const translations = sess.tracks.filter((t) => t.isTranslation);
        originals.forEach((t, i) => { t.trackNumber = i + 1; });
        // Match translations to originals by position, or just number sequentially
        translations.forEach((t, i) => { t.trackNumber = i + 1; });
      }
    }

    // Insert sessions and tracks
    for (const sess of inferredSessions) {
      const [insertedSession] = await tx
        .insert(sessions)
        .values({
          eventId,
          sessionNumber: sess.sessionNumber,
          titleEn: sess.titleEn,
          titlePt: sess.titleEn, // Only one title available
          sessionDate: toISODate(sess.date, startDate?.substring(0, 4) ?? null) ?? startDate,
          timePeriod: sess.timePeriod ?? "morning",
        })
        .onConflictDoNothing()
        .returning({ id: sessions.id });

      if (!insertedSession) continue;

      const sessionId = insertedSession.id;
      stats.sessionsInserted++;

      // Insert tracks for this session
      for (const sessTrack of sess.tracks) {
        // Find the corresponding extracted track for file size and s3Key
        const matchedExtracted = parsedTracks.find(
          (pt) => pt.parsed.originalFilename === sessTrack.originalFilename,
        );
        const s3Key = matchedExtracted?.extracted.s3Key ?? null;
        const fileSize = matchedExtracted?.extracted.size ?? null;

        await tx
          .insert(tracks)
          .values({
            sessionId,
            trackNumber: sessTrack.trackNumber,
            title: sessTrack.title,
            speaker: sessTrack.speaker,
            languages: sessTrack.languages,
            originalLanguage: sessTrack.originalLanguage,
            isTranslation: sessTrack.isTranslation,
            s3Key,
            fileSizeBytes: fileSize,
            originalFilename: sessTrack.originalFilename,
            durationSeconds: 0, // Unknown until file is probed
          })
          .onConflictDoNothing();
        stats.tracksInserted++;
      }
    }
  }

  // ---- Insert transcripts ----
  const eventTranscripts = extractTranscripts(inventoryEvent, rosettaEvent, code);
  for (const tr of eventTranscripts) {
    const pageCount = csv?.transcript1Pages
      ? parseInt(csv.transcript1Pages, 10) || null
      : null;

    await tx
      .insert(transcripts)
      .values({
        eventId,
        language: tr.language,
        s3Key: tr.s3Key,
        pageCount,
        status: "published",
        originalFilename: tr.basename,
        fileSizeBytes: tr.size,
      })
      .onConflictDoNothing();
    stats.transcriptsInserted++;
  }

  // ---- Insert event files (images, subtitles, documents, etc.) ----
  const otherFiles = extractEventFiles(inventoryEvent, code);
  for (const ef of otherFiles) {
    await tx
      .insert(eventFiles)
      .values({
        eventId,
        originalFilename: ef.basename,
        s3Key: ef.s3Key,
        fileType: ef.fileType,
        extension: ef.extension,
        fileSizeBytes: ef.size,
        language: ef.language,
      })
      .onConflictDoNothing();
    stats.eventFilesInserted++;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { dryRun, eventFilter } = parseArgs();

  console.log("=== Phase 4: Seed Content Metadata ===");
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  if (eventFilter) {
    console.log(`Filter: ${[...eventFilter].join(", ")}`);
  }
  console.log();

  // Resolve project root: script is at padmakara-api/src/scripts/seed-content.ts
  const projectRoot = path.resolve(import.meta.dirname, "../../..");
  const rosettaPath = path.join(projectRoot, "scripts/migration/rosetta-stone.json");
  const inventoryPath = path.join(projectRoot, "scripts/migration/s3-inventory.json");

  console.log(`Loading rosetta-stone.json from ${rosettaPath}`);
  const rosettaData = loadJSON<{ metadata: any; events: RosettaEvent[] }>(rosettaPath);

  console.log(`Loading s3-inventory.json from ${inventoryPath}`);
  const inventoryData = loadJSON<{ metadata: any; events: InventoryEvent[] }>(inventoryPath);

  // Build inventory lookup by canonical code
  const inventoryByCode = new Map<string, InventoryEvent>();
  for (const ie of inventoryData.events) {
    inventoryByCode.set(ie.canonicalCode, ie);
  }

  // Filter events if requested
  let rosettaEvents = rosettaData.events;

  // Always skip non-event folders (e.g. mediateca/Chants)
  const SKIP_CODES = new Set(["YYYYMMDD-VAR-CHA-PAD"]);
  rosettaEvents = rosettaEvents.filter((e) => !SKIP_CODES.has(e.canonicalCode));

  if (eventFilter) {
    rosettaEvents = rosettaEvents.filter((e) => eventFilter.has(e.canonicalCode));
    console.log(`Filtered to ${rosettaEvents.length} events`);
  }

  console.log(
    `\nProcessing ${rosettaEvents.length} events ` +
      `(${rosettaData.metadata.matchedEvents} matched, ` +
      `${rosettaData.metadata.s3OnlyEvents} s3_only)`,
  );
  console.log();

  // Load reference data
  console.log("Loading reference data from database...");
  const ref = await loadRefData();
  console.log(
    `  Teachers: ${ref.teachersByName.size} | Places: ${ref.placesByName.size} | ` +
      `Groups: ${ref.groupsByPt.size} | Event types: ${ref.eventTypeRecords.length} | ` +
      `Audiences: ${ref.audienceRecords.length}`,
  );
  console.log();

  const stats: SeedStats = {
    eventsInserted: 0,
    eventsSkipped: 0,
    sessionsInserted: 0,
    tracksInserted: 0,
    transcriptsInserted: 0,
    eventFilesInserted: 0,
    junctionTeachers: 0,
    junctionPlaces: 0,
    junctionGroups: 0,
    errors: [],
  };

  if (dryRun) {
    // Dry run: no transaction, just inspect
    for (const rosettaEvent of rosettaEvents) {
      try {
        const inventoryEvent = inventoryByCode.get(rosettaEvent.canonicalCode);
        // Pass db as "tx" for type compatibility -- no writes happen in dry run
        await seedEvent(db as any, rosettaEvent, inventoryEvent, ref, stats, true);
      } catch (err: any) {
        stats.errors.push(`${rosettaEvent.canonicalCode}: ${err.message}`);
        console.error(`  [ERROR] ${rosettaEvent.canonicalCode}: ${err.message}`);
      }
    }
  } else {
    // Live run: wrap everything in a single transaction
    await db.transaction(async (tx) => {
      for (const rosettaEvent of rosettaEvents) {
        try {
          const inventoryEvent = inventoryByCode.get(rosettaEvent.canonicalCode);
          await seedEvent(tx, rosettaEvent, inventoryEvent, ref, stats, false);
        } catch (err: any) {
          stats.errors.push(`${rosettaEvent.canonicalCode}: ${err.message}`);
          console.error(`  [ERROR] ${rosettaEvent.canonicalCode}: ${err.message}`);
          // Continue with remaining events -- onConflictDoNothing handles duplicates
        }
      }
    });
  }

  // ---- Summary ----
  console.log("\n=== Seed Summary ===");
  console.log(`Events inserted:    ${stats.eventsInserted}`);
  console.log(`Events skipped:     ${stats.eventsSkipped}`);
  console.log(`Sessions inserted:  ${stats.sessionsInserted}`);
  console.log(`Tracks inserted:    ${stats.tracksInserted}`);
  console.log(`Transcripts:        ${stats.transcriptsInserted}`);
  console.log(`Event files:        ${stats.eventFilesInserted}`);
  console.log(`Junction teachers:  ${stats.junctionTeachers}`);
  console.log(`Junction places:    ${stats.junctionPlaces}`);
  console.log(`Junction groups:    ${stats.junctionGroups}`);

  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    for (const err of stats.errors) {
      console.log(`  - ${err}`);
    }
  }

  if (dryRun) {
    console.log("\n[DRY RUN] No changes written to database.");
  } else {
    console.log("\nSeed complete.");
  }

  process.exit(stats.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
