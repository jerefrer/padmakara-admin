/**
 * Migration CSV Analysis and S3 File Discovery
 *
 * Parses Wix CSV export and discovers all S3 files per event using prefix-based search.
 * Trusts CSV as the file manifest — track names from the CSV are the source of truth.
 *
 * Discovery strategy:
 * 1. Extract S3 prefix from download URLs (e.g., "mediateca/2010-03-08-MTR")
 * 2. List ALL files under that prefix in the old bucket
 * 3. Classify: ZIPs (need extraction), loose audio (copy), transcripts, system files
 * 4. Match S3 files against CSV track list
 * 5. Auto-generate decisions (include/ignore/review)
 */

import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { db } from "../db/index.ts";
import { migrationFileCatalogs, migrationFileDecisions } from "../db/schema/index.ts";
import { parseWixRow, type WixRow } from "./csv-parser.ts";
import { extractS3Prefix, listS3Prefix } from "./s3-utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface AnalysisResult {
  totalEvents: number;
  validEvents: number;
  eventsWithAudio: number;
  eventsWithVideo: number;
  eventsWithoutMedia: number;
  totalAudioFiles: number;
  totalVideoFiles: number;
  totalDocuments: number;
  totalArchives: number;
  totalOtherFiles: number;
  totalSize: number;
  // New prefix-discovery fields
  eventsWithZips: number;
  eventsWithLooseFiles: number;
  csvTrackMatches: number;
  csvTracksMissing: number;
  issues: Array<{
    severity: "error" | "warning" | "info";
    category: string;
    message: string;
    eventCode: string;
    details?: any;
  }>;
}

type FileType = "audio" | "video" | "document" | "image" | "archive" | "other";
type FileCategory =
  | "audio_main" | "audio_translation" | "audio_legacy"
  | "video" | "transcript" | "document" | "image" | "archive" | "other";
type SuggestedAction = "include" | "ignore" | "review";

interface DiscoveredFile {
  filename: string;
  s3Key: string;
  s3Directory: string;
  fileType: FileType;
  category: FileCategory;
  extension: string;
  mimeType: string;
  suggestedAction: SuggestedAction;
  metadata: {
    targetS3Key: string;
    matchedInCSV: boolean;
    sourceType: "zip" | "loose_audio" | "transcript" | "system_file" | "other";
    [key: string]: any;
  };
}

// ============================================================================
// File Classification Helpers
// ============================================================================

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac", "wma", "opus", "aiff"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt", "rtf"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "tiff"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2"]);
const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "__macosx"]);

function getFileType(ext: string): FileType {
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  return "other";
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac",
    ogg: "audio/ogg", aac: "audio/aac",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    mkv: "video/x-matroska", webm: "video/webm",
    pdf: "application/pdf", doc: "application/msword", txt: "text/plain",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    zip: "application/zip", rar: "application/x-rar-compressed",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

function isSystemFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.startsWith(".")) return true;
  if (lower.startsWith("._")) return true;
  if (SYSTEM_FILES.has(lower)) return true;
  // __MACOSX directory files
  if (lower.includes("__macosx")) return true;
  return false;
}

/**
 * Determine audio category from S3 path.
 * - /Audio1/, /audio 1/, or files directly in event root → audio_main
 * - /Audio2/, /audio 2/ → audio_translation
 * - /Legacy/ → audio_legacy
 */
function classifyAudioCategory(s3Key: string): FileCategory {
  const lower = s3Key.toLowerCase();
  if (lower.includes("/audio2/") || lower.includes("/audio 2/")) return "audio_translation";
  if (lower.includes("/legacy/")) return "audio_legacy";
  return "audio_main";
}

/**
 * Determine if a document is a transcript based on path.
 */
function isTranscriptPath(s3Key: string): boolean {
  const lower = s3Key.toLowerCase();
  return lower.includes("transcri") || lower.includes("transcrição") || lower.includes("transcricao");
}

/**
 * Compute target S3 key in the new bucket structure.
 */
function computeTargetS3Key(eventCode: string, filename: string, category: FileCategory): string {
  switch (category) {
    case "audio_main":
    case "audio_legacy":
      return `events/${eventCode}/${filename}`;
    case "audio_translation":
      return `events/${eventCode}/audio2/${filename}`;
    case "transcript":
      return `events/${eventCode}/transcripts/${filename}`;
    case "video":
      return `events/${eventCode}/video/${filename}`;
    default:
      return `events/${eventCode}/other/${filename}`;
  }
}

// ============================================================================
// CSV Parsing (unchanged)
// ============================================================================

/**
 * Parse Wix CSV file
 */
export async function parseWixCSV(csvPath: string): Promise<WixRow[]> {
  const csvContent = readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, ""); // Remove BOM
  const rawRows: Record<string, string>[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  return rawRows.map(parseWixRow).filter(row => row.eventCode);
}

// ============================================================================
// S3 Prefix Discovery & Analysis
// ============================================================================

/**
 * Discover and classify all S3 files for an event.
 *
 * @param eventCode - Event identifier from CSV
 * @param row - Full CSV row data
 * @param sourceBucket - Old S3 bucket to search in
 * @returns Array of discovered files with classifications
 */
async function discoverEventFiles(
  eventCode: string,
  row: WixRow,
  sourceBucket: string,
): Promise<{ files: DiscoveredFile[]; s3Prefix: string | null }> {
  // Try to get S3 prefix from download URLs
  let s3Prefix: string | null = null;

  if (row.audio1.downloadUrl) {
    s3Prefix = extractS3Prefix(row.audio1.downloadUrl);
  }
  if (!s3Prefix && row.audio2.downloadUrl) {
    s3Prefix = extractS3Prefix(row.audio2.downloadUrl);
  }
  // Fallback: construct prefix from event code
  if (!s3Prefix) {
    s3Prefix = `mediateca/${eventCode}`;
  }

  // Discover ALL files under this prefix in the old bucket
  const allS3Keys = await listS3Prefix(s3Prefix, sourceBucket);

  if (allS3Keys.length === 0) {
    return { files: [], s3Prefix };
  }

  // Build set of expected CSV tracks for matching
  const csvAudio1Tracks = new Set(row.audio1.trackNames.map(t => t.toLowerCase()));
  const csvAudio2Tracks = new Set(row.audio2.trackNames.map(t => t.toLowerCase()));
  const allCsvTracks = new Set([...csvAudio1Tracks, ...csvAudio2Tracks]);

  const files: DiscoveredFile[] = [];

  for (const s3Key of allS3Keys) {
    const filename = s3Key.split("/").pop() || s3Key;
    const directory = s3Key.substring(0, s3Key.lastIndexOf("/"));
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    // Skip system files
    if (isSystemFile(filename)) {
      files.push({
        filename, s3Key, s3Directory: directory,
        fileType: "other", category: "other", extension,
        mimeType: "application/octet-stream",
        suggestedAction: "ignore",
        metadata: { targetS3Key: "", matchedInCSV: false, sourceType: "system_file" },
      });
      continue;
    }

    const fileType = getFileType(extension);
    const mimeType = getMimeType(extension);
    let category: FileCategory;
    let suggestedAction: SuggestedAction;
    let sourceType: DiscoveredFile["metadata"]["sourceType"];
    let matchedInCSV = false;

    if (fileType === "archive") {
      // ZIPs need extraction
      category = "archive";
      suggestedAction = "include";
      sourceType = "zip";
    } else if (fileType === "audio") {
      // Classify by path (audio1 vs audio2)
      category = classifyAudioCategory(s3Key);
      sourceType = "loose_audio";

      // Check if filename appears in CSV track list
      matchedInCSV = allCsvTracks.has(filename.toLowerCase());

      suggestedAction = "include";
    } else if (fileType === "document" && extension === "pdf") {
      // PDFs — check if in transcript path
      category = isTranscriptPath(s3Key) ? "transcript" : "document";
      sourceType = category === "transcript" ? "transcript" : "other";
      suggestedAction = "include";
    } else if (fileType === "video") {
      category = "video";
      sourceType = "other";
      suggestedAction = "include";
    } else {
      category = fileType === "document" ? "document"
        : fileType === "image" ? "image"
        : "other";
      sourceType = "other";
      suggestedAction = "review";
    }

    const targetS3Key = computeTargetS3Key(eventCode, filename, category);

    files.push({
      filename, s3Key, s3Directory: directory,
      fileType, category, extension, mimeType,
      suggestedAction,
      metadata: { targetS3Key, matchedInCSV, sourceType },
    });
  }

  return { files, s3Prefix };
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze CSV and catalog all S3 files using prefix-based discovery.
 *
 * @param migrationId - ID of the migration record
 * @param csvRows - Parsed CSV rows
 * @param sourceBucket - Old S3 bucket to search in (default: "padmakara-pt")
 */
export async function analyzeAndCatalog(
  migrationId: number,
  csvRows: WixRow[],
  sourceBucket: string = "padmakara-pt",
): Promise<AnalysisResult> {
  const issues: AnalysisResult["issues"] = [];

  let totalAudioFiles = 0;
  let totalVideoFiles = 0;
  let totalDocuments = 0;
  let totalArchives = 0;
  let totalOtherFiles = 0;
  let totalSize = 0;
  let eventsWithAudio = 0;
  let eventsWithVideo = 0;
  let eventsWithoutMedia = 0;
  let eventsWithZips = 0;
  let eventsWithLooseFiles = 0;
  let csvTrackMatches = 0;
  let csvTracksMissing = 0;

  console.log(`\n📊 Analyzing ${csvRows.length} events via S3 prefix discovery (bucket: ${sourceBucket})...\n`);

  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i]!;
    console.log(`[${i + 1}/${csvRows.length}] ${row.eventCode}: ${row.title || "Untitled"}`);

    try {
      const { files, s3Prefix } = await discoverEventFiles(row.eventCode, row, sourceBucket);

      if (files.length === 0) {
        eventsWithoutMedia++;
        issues.push({
          severity: "warning",
          category: "s3",
          message: `No files found under ${s3Prefix}`,
          eventCode: row.eventCode,
        });
        console.log(`   ⚠ No files found under ${s3Prefix}`);
        continue;
      }

      // Count file types
      const audioFiles = files.filter(f => f.fileType === "audio");
      const videoFiles = files.filter(f => f.fileType === "video");
      const docFiles = files.filter(f => f.fileType === "document");
      const archiveFiles = files.filter(f => f.fileType === "archive");
      const otherFiles = files.filter(f => !["audio", "video", "document", "archive"].includes(f.fileType) && f.metadata.sourceType !== "system_file");

      totalAudioFiles += audioFiles.length;
      totalVideoFiles += videoFiles.length;
      totalDocuments += docFiles.length;
      totalArchives += archiveFiles.length;
      totalOtherFiles += otherFiles.length;

      if (audioFiles.length > 0) eventsWithAudio++;
      if (videoFiles.length > 0) eventsWithVideo++;

      // Track ZIP vs loose file stats
      const hasZips = archiveFiles.length > 0;
      const hasLooseAudio = audioFiles.length > 0;
      if (hasZips) eventsWithZips++;
      if (hasLooseAudio) eventsWithLooseFiles++;

      // CSV manifest matching
      const allCsvTracks = [...row.audio1.trackNames, ...row.audio2.trackNames];
      const matchedFiles = files.filter(f => f.metadata.matchedInCSV);
      csvTrackMatches += matchedFiles.length;

      // Count CSV tracks that weren't found as loose files
      // (they might be inside ZIPs, which is fine — we trust the CSV)
      const foundFilenames = new Set(audioFiles.map(f => f.filename.toLowerCase()));
      const missingFromS3 = allCsvTracks.filter(t => !foundFilenames.has(t.toLowerCase()));
      csvTracksMissing += missingFromS3.length;

      // Save to migration_file_catalogs
      const catalogIds: number[] = [];
      for (const file of files) {
        const [inserted] = await db.insert(migrationFileCatalogs).values({
          migrationId,
          eventCode: row.eventCode,
          s3Directory: file.s3Directory,
          filename: file.filename,
          s3Key: file.s3Key,
          fileType: file.fileType,
          category: file.category,
          extension: file.extension,
          mimeType: file.mimeType,
          suggestedAction: file.suggestedAction,
          suggestedCategory: file.category,
          conflicts: [],
          metadata: file.metadata,
        }).returning({ id: migrationFileCatalogs.id });
        catalogIds.push(inserted!.id);

        // Auto-generate decisions for obvious cases
        if (file.suggestedAction === "include" || file.suggestedAction === "ignore") {
          await db.insert(migrationFileDecisions).values({
            migrationId,
            catalogId: inserted!.id,
            action: file.suggestedAction,
            targetCategory: file.category,
            targetS3Key: file.metadata.targetS3Key || null,
            notes: file.suggestedAction === "ignore" ? "Auto: system file" : "Auto: matched",
          });
        }
      }

      // Log issues
      if (hasZips && !hasLooseAudio) {
        issues.push({
          severity: "info",
          category: "zip",
          message: `ZIP-only event — ${archiveFiles.length} ZIP(s) need extraction, ${allCsvTracks.length} tracks expected from CSV`,
          eventCode: row.eventCode,
          details: { zips: archiveFiles.map(z => z.filename), expectedTracks: allCsvTracks.length },
        });
      }

      if (missingFromS3.length > 0 && !hasZips) {
        issues.push({
          severity: "warning",
          category: "missing",
          message: `${missingFromS3.length} CSV track(s) not found as loose files and no ZIP available`,
          eventCode: row.eventCode,
          details: { missingTracks: missingFromS3 },
        });
      }

      if (videoFiles.length > 0) {
        issues.push({
          severity: "info",
          category: "video",
          message: `Found ${videoFiles.length} video file(s)`,
          eventCode: row.eventCode,
          details: { videos: videoFiles.map(v => v.filename) },
        });
      }

      const systemFiles = files.filter(f => f.metadata.sourceType === "system_file");
      const actionableFiles = files.length - systemFiles.length;
      console.log(`   ✓ ${files.length} files (${audioFiles.length} audio, ${archiveFiles.length} ZIPs, ${docFiles.length} docs, ${systemFiles.length} system → ignored)`);
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`);
      issues.push({
        severity: "error",
        category: "discovery",
        message: `Failed to discover files: ${error.message}`,
        eventCode: row.eventCode,
      });
    }
  }

  console.log(`\n✅ Analysis complete!`);
  console.log(`   Events with ZIPs: ${eventsWithZips}`);
  console.log(`   Events with loose files: ${eventsWithLooseFiles}`);
  console.log(`   CSV tracks matched: ${csvTrackMatches}`);
  console.log(`   CSV tracks missing (may be in ZIPs): ${csvTracksMissing}\n`);

  return {
    totalEvents: csvRows.length,
    validEvents: csvRows.length - eventsWithoutMedia,
    eventsWithAudio,
    eventsWithVideo,
    eventsWithoutMedia,
    totalAudioFiles,
    totalVideoFiles,
    totalDocuments,
    totalArchives,
    totalOtherFiles,
    totalSize,
    eventsWithZips,
    eventsWithLooseFiles,
    csvTrackMatches,
    csvTracksMissing,
    issues,
  };
}
