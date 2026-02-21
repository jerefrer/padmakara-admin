/**
 * S3 utilities for migration: file verification, state detection, and extraction triggering.
 */

import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const AWS_REGION = process.env.AWS_S3_REGION_NAME ?? "eu-west-3";
const SOURCE_BUCKET = process.env.AWS_STORAGE_BUCKET_NAME ?? "padmakara-pt-sample"; // Migration target bucket
const LAMBDA_ZIP_EXTRACTOR = process.env.AWS_LAMBDA_ZIP_EXTRACTOR_NAME ?? "";

// Export for use in migration script
export const BUCKET = SOURCE_BUCKET;

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  },
});

const lambdaClient = new LambdaClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  },
});

export type S3State = "EXTRACTED" | "ZIP_ONLY" | "PARTIAL" | "MISSING";

export interface S3StateReport {
  state: S3State;
  extractedFiles: string[];
  missingFiles: string[];
  zipUrl: string | null;
  expectedTrackCount: number;
  actualFileCount: number;
}

/**
 * Check if a single S3 object exists.
 * READ-ONLY operation - safe for validation mode.
 */
export async function s3FileExists(key: string, bucket: string = SOURCE_BUCKET): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * List all files under an S3 prefix.
 * READ-ONLY operation - safe for validation mode.
 */
export async function listS3Prefix(prefix: string, bucket: string = SOURCE_BUCKET): Promise<string[]> {
  const files: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (response.Contents) {
      files.push(...response.Contents.map((obj) => obj.Key!));
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return files;
}

/**
 * Analyze S3 state for an event: are tracks extracted, or only ZIPs exist?
 */
export async function analyzeEventS3State(
  s3Prefix: string,
  expectedTracks: string[],
  zipUrl: string | null,
): Promise<S3StateReport> {
  // List all files under event prefix
  const existingFiles = await listS3Prefix(s3Prefix);

  // Filter for audio files (exclude ZIPs and other formats)
  const audioFiles = existingFiles.filter((f) =>
    /\.(mp3|wav|m4a|flac|ogg)$/i.test(f),
  );

  // Check how many expected tracks exist
  const expectedKeys = expectedTracks.map((t) => `${s3Prefix}/${t}`);
  const foundTracks: string[] = [];
  const missingTracks: string[] = [];

  for (const key of expectedKeys) {
    if (existingFiles.includes(key)) {
      foundTracks.push(key);
    } else {
      missingTracks.push(key);
    }
  }

  // Determine state
  let state: S3State;
  if (foundTracks.length === expectedTracks.length) {
    state = "EXTRACTED";
  } else if (audioFiles.length > 0) {
    state = "PARTIAL";
  } else if (zipUrl && (await s3FileExists(extractS3KeyFromUrl(zipUrl)!))) {
    state = "ZIP_ONLY";
  } else {
    state = "MISSING";
  }

  return {
    state,
    extractedFiles: foundTracks,
    missingFiles: missingTracks,
    zipUrl,
    expectedTrackCount: expectedTracks.length,
    actualFileCount: audioFiles.length,
  };
}

/**
 * Extract S3 key from a download URL.
 */
export function extractS3KeyFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("s3")) return null;
    // Decode and remove leading slash
    return decodeURIComponent(parsed.pathname).replace(/^\//, "");
  } catch {
    return null;
  }
}

/**
 * Extract S3 prefix (directory path) from download URL.
 * Example: https://...s3.../mediateca/2010-03-08-MTR-CFR-ACM/Audio1/file.zip
 * Returns: mediateca/2010-03-08-MTR-CFR-ACM
 *
 * NOTE: This is a legacy function that strips away folder structure.
 * For actual file paths, use extractS3Directory() instead.
 */
export function extractS3Prefix(url: string): string | null {
  const key = extractS3KeyFromUrl(url);
  if (!key) return null;

  // Remove filename and any intermediate directories (Audio1, audio2, etc.)
  const parts = key.split("/");

  // Keep first 2 parts: mediateca/EVENT-CODE
  if (parts.length >= 2) {
    return parts.slice(0, 2).join("/");
  }

  return key;
}

/**
 * Extract the actual directory path from a download URL (preserving folder structure).
 * Example: https://...s3.../mediateca/2010-03-08-MTR-CFR-ACM/Audio1/file.zip
 * Returns: mediateca/2010-03-08-MTR-CFR-ACM/Audio1
 */
export function extractS3Directory(url: string): string | null {
  const key = extractS3KeyFromUrl(url);
  if (!key) return null;

  // Remove just the filename, keep the full directory path
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash > 0) {
    return key.substring(0, lastSlash);
  }

  return null;
}

/**
 * Search for transcript PDF files in common locations relative to the audio folder.
 *
 * Searches in this order:
 * 1. Sibling "Transcrições" folder at same level as audio folder
 * 2. Parent "Transcrições" folder
 * 3. Specific language folders: "Transcrição 1", "Transcrição 2", "Transcription 1", etc.
 *
 * @param audioDirectory - The directory containing audio files (from extractS3Directory)
 * @returns Array of possible transcript PDF S3 keys to check
 */
export function findTranscriptPaths(audioDirectory: string): string[] {
  if (!audioDirectory) return [];

  const parts = audioDirectory.split("/");
  const paths: string[] = [];

  // Get the parent directory (e.g., "mediateca/2025-04-JKR-Retiros-CCA/20250412_13-JKR-SHAMATHA-CCA")
  const parentDir = parts.slice(0, -1).join("/");

  // Get the grandparent directory (e.g., "mediateca/2025-04-JKR-Retiros-CCA")
  const grandparentDir = parts.length > 2 ? parts.slice(0, -2).join("/") : null;

  // Common transcript folder names
  const transcriptFolders = [
    "Transcrições",
    "Transcricoes",
    "Transcrição",
    "Transcricao",
    "Transcrição 1",
    "Transcrição 2",
    "Transcription",
    "Transcriptions",
    "Transcription 1",
    "Transcription 2",
  ];

  // Search in parent directory
  if (parentDir) {
    for (const folder of transcriptFolders) {
      paths.push(`${parentDir}/${folder}`);
    }
  }

  // Search in grandparent directory
  if (grandparentDir) {
    for (const folder of transcriptFolders) {
      paths.push(`${grandparentDir}/${folder}`);
    }
  }

  return paths;
}

/**
 * Find transcript PDF files in S3 by searching common locations.
 *
 * @param audioDirectory - The directory containing audio files
 * @param language - Optional language filter (pt, en, etc.)
 * @returns S3 key of found transcript PDF, or null
 */
export async function findTranscriptInS3(
  audioDirectory: string,
  language?: string,
): Promise<string | null> {
  const searchPaths = findTranscriptPaths(audioDirectory);

  for (const searchPath of searchPaths) {
    try {
      // List files in this directory
      const objects = await listS3Prefix(searchPath);

      // Find PDF files
      const pdfFiles = objects.filter((key) => key.toLowerCase().endsWith(".pdf"));

      if (pdfFiles.length === 0) continue;

      // If language specified, try to find matching file
      if (language) {
        const langMatch = pdfFiles.find((key) =>
          key.toLowerCase().includes(language.toLowerCase()),
        );
        if (langMatch) return langMatch;
      }

      // Return first PDF found
      return pdfFiles[0] ?? null;
    } catch (err) {
      // Directory doesn't exist or is inaccessible, continue searching
      continue;
    }
  }

  return null;
}

/**
 * Trigger Lambda function to extract ZIP file to individual tracks.
 *
 * IMPORTANT: This performs WRITE operations to S3.
 * - Reads ZIP from source bucket (padmakara-pt)
 * - Extracts individual MP3 files
 * - Writes to target bucket (padmakara-pt-sample)
 * - Organizes files according to new backend structure:
 *   - Main tracks: {targetPrefix}/track.mp3
 *   - Translations: {targetPrefix}/audio2/track.mp3
 *
 * Never call this in --validate-only or --dry-run modes!
 */
export async function triggerZipExtraction(
  zipUrl: string,
  targetPrefix: string,
  targetBucket: string = SOURCE_BUCKET,
): Promise<{ success: boolean; message: string }> {
  if (!LAMBDA_ZIP_EXTRACTOR) {
    return {
      success: false,
      message: "AWS_LAMBDA_ZIP_EXTRACTOR_NAME not configured in environment",
    };
  }

  try {
    // Extract source bucket from ZIP URL
    const sourceBucket = zipUrl.includes("padmakara-pt.s3")
      ? "padmakara-pt"
      : "padmakara-pt-sample";

    const payload = {
      zipUrl,
      sourceBucket,
      targetBucket,
      targetPrefix,
    };

    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: LAMBDA_ZIP_EXTRACTOR,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    const rawResult = JSON.parse(
      Buffer.from(response.Payload ?? []).toString(),
    );

    // Lambda returns { statusCode, body: JSON.stringify({...}) }
    const body = typeof rawResult.body === "string"
      ? JSON.parse(rawResult.body)
      : rawResult;

    return {
      success: body.success ?? response.StatusCode === 200,
      message: body.message ?? "Extraction triggered",
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Lambda invocation failed: ${err.message}`,
    };
  }
}

/**
 * Download S3 object content as string (for small files like manifests).
 */
export async function downloadS3Object(key: string): Promise<string | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );

    if (!response.Body) return null;
    return await response.Body.transformToString();
  } catch {
    return null;
  }
}

/**
 * Copy an S3 object from one bucket/key to another.
 * Used for migrating loose files (already-extracted MP3s, PDFs) to the new bucket.
 *
 * S3 CopyObject is free within the same region and doesn't download data locally.
 */
export async function copyS3Object(
  sourceKey: string,
  targetKey: string,
  sourceBucket: string,
  targetBucket: string,
): Promise<boolean> {
  try {
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: targetBucket,
        Key: targetKey,
        CopySource: encodeURIComponent(`${sourceBucket}/${sourceKey}`),
      }),
    );
    return true;
  } catch (err: any) {
    console.error(`Failed to copy ${sourceBucket}/${sourceKey} → ${targetBucket}/${targetKey}: ${err.message}`);
    return false;
  }
}
