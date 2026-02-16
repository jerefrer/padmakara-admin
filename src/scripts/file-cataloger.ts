/**
 * Comprehensive File Type Detection and Cataloging
 *
 * Scans S3 directories and catalogs ALL file types:
 * - Audio files (mp3, wav, m4a, flac, ogg, aac)
 * - Video files (mp4, mov, avi, mkv, webm, flv)
 * - Documents (pdf, doc, docx, txt, rtf)
 * - Images (jpg, png, gif, svg, webp)
 * - Archives (zip, rar, 7z, tar, gz)
 * - Other files
 */

import { listS3Prefix } from "./s3-utils.ts";

export type FileCategory =
  | "audio_main"           // Main audio tracks (bilingual)
  | "audio_translation"    // Translation tracks (audio2)
  | "audio_legacy"         // Legacy unique tracks
  | "video"                // Video content
  | "transcript"           // PDF transcripts
  | "document"             // Other documents
  | "image"                // Images
  | "archive"              // ZIP/compressed files
  | "other";               // Unknown/other types

export interface CatalogedFile {
  filename: string;
  s3Key: string;
  s3Directory: string;
  fileType: "audio" | "video" | "document" | "image" | "archive" | "other";
  category: FileCategory;
  extension: string;
  size?: number;
  mimeType: string;
  suggestedAction: "include" | "ignore" | "review";
  conflicts?: string[];  // List of potential conflicts/duplicates
  metadata?: Record<string, any>;
}

export interface EventFileCatalog {
  eventCode: string;
  s3Directory: string;
  files: CatalogedFile[];
  audio1Files: CatalogedFile[];
  audio2Files: CatalogedFile[];
  videoFiles: CatalogedFile[];
  documentFiles: CatalogedFile[];
  archiveFiles: CatalogedFile[];
  otherFiles: CatalogedFile[];
  totalFiles: number;
  totalSize: number;
}

/**
 * File type detection by extension
 */
const FILE_TYPE_MAP = {
  // Audio
  audio: [
    "mp3", "wav", "m4a", "flac", "ogg", "aac", "wma",
    "opus", "alac", "ape", "aiff", "au"
  ],
  // Video
  video: [
    "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv",
    "m4v", "mpg", "mpeg", "3gp", "ogv", "ts", "vob"
  ],
  // Documents
  document: [
    "pdf", "doc", "docx", "txt", "rtf", "odt", "pages",
    "md", "tex", "epub", "mobi"
  ],
  // Images
  image: [
    "jpg", "jpeg", "png", "gif", "svg", "webp", "bmp",
    "tiff", "ico", "heic", "heif", "raw", "psd"
  ],
  // Archives
  archive: [
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
    "tgz", "tbz", "cab", "iso", "dmg"
  ],
} as const;

/**
 * MIME type mapping
 */
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    flac: "audio/flac",
    ogg: "audio/ogg",
    aac: "audio/aac",
    // Video
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    svg: "image/svg+xml",
    // Archives
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
  };
  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}

/**
 * Detect file type from extension
 */
function detectFileType(filename: string): "audio" | "video" | "document" | "image" | "archive" | "other" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  for (const [type, extensions] of Object.entries(FILE_TYPE_MAP)) {
    if (extensions.includes(ext)) {
      return type as any;
    }
  }

  return "other";
}

/**
 * Suggest category based on file location and type
 */
function suggestCategory(
  filename: string,
  s3Key: string,
  fileType: "audio" | "video" | "document" | "image" | "archive" | "other"
): FileCategory {
  const lowercaseKey = s3Key.toLowerCase();
  const lowercaseFilename = filename.toLowerCase();

  // Documents - PDFs in transcript folders
  if (fileType === "document" && lowercaseFilename.endsWith(".pdf")) {
    if (
      lowercaseKey.includes("transcript") ||
      lowercaseKey.includes("transcrição") ||
      lowercaseKey.includes("transcricao")
    ) {
      return "transcript";
    }
    return "document";
  }

  // Videos
  if (fileType === "video") {
    return "video";
  }

  // Audio files
  if (fileType === "audio") {
    // Audio2 folder = translations
    if (lowercaseKey.includes("/audio2/") || lowercaseKey.includes("/audio 2/")) {
      return "audio_translation";
    }

    // Legacy folder
    if (lowercaseKey.includes("/legacy/")) {
      return "audio_legacy";
    }

    // Default to main audio
    return "audio_main";
  }

  // Archives
  if (fileType === "archive") {
    return "archive";
  }

  // Documents
  if (fileType === "document") {
    return "document";
  }

  // Images
  if (fileType === "image") {
    return "image";
  }

  return "other";
}

/**
 * Suggest action for file
 */
function suggestAction(
  filename: string,
  fileType: "audio" | "video" | "document" | "image" | "archive" | "other",
  category: FileCategory
): "include" | "ignore" | "review" {
  const lowercaseFilename = filename.toLowerCase();

  // Ignore system files
  if (
    lowercaseFilename.startsWith(".") ||
    lowercaseFilename === "thumbs.db" ||
    lowercaseFilename === "desktop.ini" ||
    lowercaseFilename === ".ds_store"
  ) {
    return "ignore";
  }

  // Include audio, video, transcripts by default
  if (
    fileType === "audio" ||
    fileType === "video" ||
    category === "transcript"
  ) {
    return "include";
  }

  // Review archives (might contain audio)
  if (fileType === "archive") {
    return "review";
  }

  // Review other documents and images
  if (fileType === "document" || fileType === "image") {
    return "review";
  }

  // Review unknown types
  return "review";
}

/**
 * Find potential conflicts/duplicates
 */
function findConflicts(file: CatalogedFile, allFiles: CatalogedFile[]): string[] {
  const conflicts: string[] = [];

  // Normalize filename for comparison (remove spaces, lowercase, etc.)
  const normalizeFilename = (name: string) =>
    name.toLowerCase().replace(/[\s_-]+/g, "").replace(/\.[^.]+$/, "");

  const normalizedName = normalizeFilename(file.filename);

  for (const other of allFiles) {
    if (other.s3Key === file.s3Key) continue; // Skip self

    const otherNormalized = normalizeFilename(other.filename);

    // Exact match (different paths)
    if (file.filename.toLowerCase() === other.filename.toLowerCase()) {
      conflicts.push(`Duplicate: ${other.s3Key}`);
    }

    // Similar names (potential typos)
    else if (normalizedName === otherNormalized) {
      conflicts.push(`Similar name: ${other.filename} at ${other.s3Directory}`);
    }

    // Close Levenshtein distance (typos)
    else if (levenshteinDistance(normalizedName, otherNormalized) <= 2) {
      conflicts.push(`Possible typo: ${other.filename} at ${other.s3Directory}`);
    }
  }

  return conflicts;
}

/**
 * Simple Levenshtein distance for typo detection
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Catalog all files in an event's S3 directory
 */
export async function catalogEventFiles(
  eventCode: string,
  s3Directory: string
): Promise<EventFileCatalog> {
  // List all files in the S3 directory recursively
  const allS3Keys = await listS3Prefix(s3Directory);

  const files: CatalogedFile[] = [];

  for (const s3Key of allS3Keys) {
    const filename = s3Key.split("/").pop() || s3Key;
    const directory = s3Key.substring(0, s3Key.lastIndexOf("/"));
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    const fileType = detectFileType(filename);
    const category = suggestCategory(filename, s3Key, fileType);
    const suggestedActionValue = suggestAction(filename, fileType, category);
    const mimeType = getMimeType(extension);

    files.push({
      filename,
      s3Key,
      s3Directory: directory,
      fileType,
      category,
      extension,
      mimeType,
      suggestedAction: suggestedActionValue,
      conflicts: [],  // Will be populated later
    });
  }

  // Find conflicts for each file
  for (const file of files) {
    file.conflicts = findConflicts(file, files);
  }

  // Categorize files
  const audio1Files = files.filter(
    f => f.fileType === "audio" &&
    (f.category === "audio_main" ||
     f.s3Directory.toLowerCase().includes("audio1") ||
     f.s3Directory.toLowerCase().includes("audio 1"))
  );

  const audio2Files = files.filter(
    f => f.fileType === "audio" &&
    (f.category === "audio_translation" ||
     f.s3Directory.toLowerCase().includes("audio2") ||
     f.s3Directory.toLowerCase().includes("audio 2"))
  );

  const videoFiles = files.filter(f => f.fileType === "video");
  const documentFiles = files.filter(f => f.fileType === "document");
  const archiveFiles = files.filter(f => f.fileType === "archive");
  const otherFiles = files.filter(
    f => !["audio", "video", "document", "archive"].includes(f.fileType)
  );

  const totalSize = 0; // Would need S3 HeadObject to get actual sizes

  return {
    eventCode,
    s3Directory,
    files,
    audio1Files,
    audio2Files,
    videoFiles,
    documentFiles,
    archiveFiles,
    otherFiles,
    totalFiles: files.length,
    totalSize,
  };
}

/**
 * Catalog multiple events in parallel
 */
export async function catalogMultipleEvents(
  events: Array<{ eventCode: string; s3Directory: string }>,
  concurrency: number = 5
): Promise<EventFileCatalog[]> {
  const results: EventFileCatalog[] = [];

  // Process in batches for concurrency control
  for (let i = 0; i < events.length; i += concurrency) {
    const batch = events.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(evt => catalogEventFiles(evt.eventCode, evt.s3Directory))
    );
    results.push(...batchResults);
  }

  return results;
}
