/**
 * Add event files (images, subtitles, documents, etc.) to existing events.
 *
 * Reads s3-inventory.json and adds non-media, non-PDF files that weren't
 * imported during initial Phase 4 seed (which only handled audio/video/PDFs).
 *
 * Usage:
 *   bun run src/scripts/add-event-files.ts                      # all events
 *   bun run src/scripts/add-event-files.ts --dry-run             # preview only
 *   bun run src/scripts/add-event-files.ts --events CODE1,CODE2  # specific events
 */

import { readFileSync } from "fs";
import { db } from "../db/index.ts";
import { eventFiles } from "../db/schema/event-files.ts";
import { mapLanguage } from "./csv-parser.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const eventFilter = process.argv.find((arg) => arg.startsWith("--events="))?.split("=")[1]?.split(",");

console.log("=== Add Event Files (Images, Subtitles, Documents, etc.) ===");
console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
if (eventFilter) console.log(`Filter: ${eventFilter.join(", ")}`);

// ============================================================================
// Types
// ============================================================================

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
}

interface ExtractedEventFile {
  basename: string;
  s3Key: string;
  size: number;
  fileType: string; // image, subtitle, document, design, other
  extension: string;
  language: string | null;
}

// ============================================================================
// Constants
// ============================================================================

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
// Helper Functions
// ============================================================================

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
// Main Script
// ============================================================================

// Load s3-inventory.json
const inventoryPath = "/Users/jeremy/Documents/Programming/padmakara-backend-frontend/scripts/migration/s3-inventory.json";
const inventoryData = JSON.parse(readFileSync(inventoryPath, "utf-8"));
const inventory = inventoryData.events || [];

let totalEventsProcessed = 0;
let totalFilesAdded = 0;

console.log(`\nProcessing ${inventory.length} events from inventory...`);

for (const invEvent of inventory) {
  const code = invEvent.canonicalCode;

  // Apply event filter if specified
  if (eventFilter && !eventFilter.includes(code)) continue;

  console.log(`\nChecking ${code}...`);

  // Find event in database
  const event = await db.query.events.findFirst({
    where: (e, { eq }) => eq(e.eventCode, code),
  });

  if (!event) {
    console.log(`  [SKIP] ${code}: not found in database`);
    continue;
  }

  console.log(`  Found in database: ${event.titleEn || event.titlePt || code}`);

  // Extract event files from inventory
  const otherFiles = extractEventFiles(invEvent, code);

  console.log(`  Found ${otherFiles.length} event files in inventory`);

  if (otherFiles.length === 0) {
    continue; // No event files for this event
  }

  // Group by file type for display
  const filesByType = new Map<string, ExtractedEventFile[]>();
  for (const ef of otherFiles) {
    if (!filesByType.has(ef.fileType)) {
      filesByType.set(ef.fileType, []);
    }
    filesByType.get(ef.fileType)!.push(ef);
  }

  console.log(`  File types found:`);
  for (const [type, files] of filesByType) {
    console.log(`    - ${type}: ${files.length} files`);
  }

  let filesAddedForEvent = 0;

  for (const ef of otherFiles) {
    console.log(`  [ADD] ${ef.fileType}: ${ef.basename} (${ef.extension})`);

    if (!DRY_RUN) {
      await db.insert(eventFiles).values({
        eventId: event.id,
        originalFilename: ef.basename,
        s3Key: ef.s3Key,
        fileType: ef.fileType,
        extension: ef.extension,
        fileSizeBytes: ef.size,
        language: ef.language,
      }).onConflictDoNothing();
    }

    filesAddedForEvent++;
    totalFilesAdded++;
  }

  if (filesAddedForEvent > 0) {
    console.log(`[PROCESSED] ${code}: ${filesAddedForEvent} files added`);
    totalEventsProcessed++;
  }
}

console.log("\n=== Summary ===");
console.log(`Events processed: ${totalEventsProcessed}`);
console.log(`Event files added: ${totalFilesAdded}`);
if (DRY_RUN) console.log("\n[DRY RUN] No changes made to database");
