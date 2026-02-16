/**
 * Migration CSV Analysis and File Cataloging
 *
 * Parses Wix CSV export and catalogs all S3 files per event.
 */

import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { db } from "../db/index.ts";
import { migrationFileCatalogs } from "../db/schema/index.ts";
import { parseWixRow, type WixRow } from "./csv-parser.ts";
import { extractS3Prefix, extractS3Directory } from "./s3-utils.ts";
import { catalogEventFiles, type EventFileCatalog } from "./file-cataloger.ts";

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
  issues: Array<{
    severity: "error" | "warning" | "info";
    category: string;
    message: string;
    eventCode: string;
    details?: any;
  }>;
  eventCatalogs: EventFileCatalog[];
}

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

/**
 * Analyze CSV and catalog all S3 files
 */
export async function analyzeAndCatalog(
  migrationId: number,
  csvRows: WixRow[]
): Promise<AnalysisResult> {
  const issues: AnalysisResult["issues"] = [];
  const eventCatalogs: EventFileCatalog[] = [];

  let totalAudioFiles = 0;
  let totalVideoFiles = 0;
  let totalDocuments = 0;
  let totalArchives = 0;
  let totalOtherFiles = 0;
  let totalSize = 0;
  let eventsWithAudio = 0;
  let eventsWithVideo = 0;
  let eventsWithoutMedia = 0;

  console.log(`\n📊 Analyzing ${csvRows.length} events and cataloging S3 files...\n`);

  // Process each event
  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i]!;
    console.log(`[${i + 1}/${csvRows.length}] ${row.eventCode}: ${row.title || "Untitled"}`);

    try {
      // Get S3 directory from audio1 or audio2 download URL
      let s3Directory: string | null = null;

      if (row.audio1.downloadUrl) {
        s3Directory = extractS3Directory(row.audio1.downloadUrl);
      } else if (row.audio2.downloadUrl) {
        s3Directory = extractS3Directory(row.audio2.downloadUrl);
      }

      // If no S3 directory found, use prefix
      if (!s3Directory && row.audio1.downloadUrl) {
        s3Directory = extractS3Prefix(row.audio1.downloadUrl);
      } else if (!s3Directory && row.audio2.downloadUrl) {
        s3Directory = extractS3Prefix(row.audio2.downloadUrl);
      }

      if (!s3Directory) {
        // No audio URLs - check if event has any media
        eventsWithoutMedia++;
        issues.push({
          severity: "warning",
          category: "s3",
          message: "No S3 directory found - no audio URLs",
          eventCode: row.eventCode,
        });
        continue;
      }

      // Remove the audio folder suffix to get event root
      // e.g., "mediateca/2022-05-05-MTR/Audio1" -> "mediateca/2022-05-05-MTR"
      const eventRoot = s3Directory.split("/").slice(0, -1).join("/");

      // Catalog all files in event directory
      const catalog = await catalogEventFiles(row.eventCode, eventRoot);
      eventCatalogs.push(catalog);

      // Update statistics
      totalAudioFiles += catalog.audio1Files.length + catalog.audio2Files.length;
      totalVideoFiles += catalog.videoFiles.length;
      totalDocuments += catalog.documentFiles.length;
      totalArchives += catalog.archiveFiles.length;
      totalOtherFiles += catalog.otherFiles.length;
      totalSize += catalog.totalSize;

      if (catalog.audio1Files.length > 0 || catalog.audio2Files.length > 0) {
        eventsWithAudio++;
      }

      if (catalog.videoFiles.length > 0) {
        eventsWithVideo++;
      }

      // Save to database
      for (const file of catalog.files) {
        await db.insert(migrationFileCatalogs).values({
          migrationId,
          eventCode: row.eventCode,
          s3Directory: file.s3Directory,
          filename: file.filename,
          s3Key: file.s3Key,
          fileType: file.fileType,
          category: file.category,
          extension: file.extension,
          fileSize: file.size,
          mimeType: file.mimeType,
          suggestedAction: file.suggestedAction,
          suggestedCategory: file.category,
          conflicts: file.conflicts || [],
          metadata: file.metadata || {},
        });
      }

      // Check for issues
      if (catalog.videoFiles.length > 0) {
        issues.push({
          severity: "info",
          category: "video",
          message: `Found ${catalog.videoFiles.length} video file(s)`,
          eventCode: row.eventCode,
          details: { videos: catalog.videoFiles.map(v => v.filename) },
        });
      }

      if (catalog.archiveFiles.length > 0) {
        issues.push({
          severity: "warning",
          category: "archive",
          message: `Found ${catalog.archiveFiles.length} archive file(s) - may contain audio`,
          eventCode: row.eventCode,
          details: { archives: catalog.archiveFiles.map(a => a.filename) },
        });
      }

      // Check for conflicts
      const filesWithConflicts = catalog.files.filter(f => f.conflicts && f.conflicts.length > 0);
      if (filesWithConflicts.length > 0) {
        issues.push({
          severity: "warning",
          category: "conflicts",
          message: `Found ${filesWithConflicts.length} file(s) with potential conflicts`,
          eventCode: row.eventCode,
          details: {
            conflicts: filesWithConflicts.map(f => ({
              filename: f.filename,
              conflicts: f.conflicts,
            })),
          },
        });
      }

      console.log(`   ✓ Cataloged ${catalog.totalFiles} files (${catalog.audio1Files.length + catalog.audio2Files.length} audio, ${catalog.videoFiles.length} video)`);
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`);
      issues.push({
        severity: "error",
        category: "cataloging",
        message: `Failed to catalog files: ${error.message}`,
        eventCode: row.eventCode,
      });
    }
  }

  console.log(`\n✅ Analysis complete!\n`);

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
    issues,
    eventCatalogs,
  };
}
