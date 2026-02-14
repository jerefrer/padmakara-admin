/**
 * Populate track durations by reading audio metadata from S3.
 *
 * Uses HTTP Range requests to fetch only the first ~512KB of each file,
 * then music-metadata parses audio headers to extract duration.
 * This avoids downloading entire files (which could be 50MB+ each).
 *
 * Usage:
 *   bun run src/scripts/populate-track-durations.ts                # full run
 *   bun run src/scripts/populate-track-durations.ts --dry-run      # inspect only
 *   bun run src/scripts/populate-track-durations.ts --limit 10     # process first N
 *   bun run src/scripts/populate-track-durations.ts --concurrency 3  # parallel requests
 *   bun run src/scripts/populate-track-durations.ts --prefix events/20250417  # filter by s3Key prefix
 *   bun run src/scripts/populate-track-durations.ts --bucket padmakara-pt-app  # override S3 bucket
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq, and, isNotNull, like } from "drizzle-orm";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.ts";
import { parseBuffer } from "music-metadata";

// How many bytes to fetch per file — 512KB is enough for MP3 headers + Xing/VBRI
const RANGE_BYTES = 512 * 1024;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]!, 10) : undefined;
const concIdx = args.indexOf("--concurrency");
const concurrency = concIdx !== -1 ? parseInt(args[concIdx + 1]!, 10) : 5;
const prefixIdx = args.indexOf("--prefix");
const prefix = prefixIdx !== -1 ? args[prefixIdx + 1]! : undefined;
const bucketIdx = args.indexOf("--bucket");
const bucketOverride = bucketIdx !== -1 ? args[bucketIdx + 1]! : undefined;

// If --bucket is specified, create a custom presigned URL generator
let getPresignedUrl = (key: string, expiresIn: number) =>
  generatePresignedDownloadUrl(key, expiresIn);

if (bucketOverride) {
  const s3Client = new S3Client({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  getPresignedUrl = (key: string, expiresIn: number) =>
    getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucketOverride, Key: key }),
      { expiresIn },
    );
}

async function getTrackDuration(
  s3Key: string,
  knownFileSize: number | null,
): Promise<number | null> {
  try {
    const url = await getPresignedUrl(s3Key, 300);

    // Fetch only the first RANGE_BYTES using HTTP Range header
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });

    if (!response.ok && response.status !== 206) {
      console.error(`  HTTP ${response.status} for ${s3Key}`);
      return null;
    }

    // Extract total file size from Content-Range header: "bytes 0-524287/52428800"
    const contentRange = response.headers.get("content-range");
    const totalSize = contentRange
      ? parseInt(contentRange.split("/")[1] || "0", 10)
      : knownFileSize || 0;

    const buffer = new Uint8Array(await response.arrayBuffer());

    const metadata = await parseBuffer(
      buffer,
      { mimeType: "audio/mpeg", size: totalSize || undefined },
      { skipCovers: true },
    );

    const duration = metadata.format.duration;
    return duration && duration > 0 ? Math.round(duration) : null;
  } catch (error: any) {
    // Common: "End-Of-Stream" when buffer is too short for full parse — that's OK
    // music-metadata may still have extracted duration before the error
    if (error.message?.includes("End-Of-Stream")) {
      return null;
    }
    console.error(`  Error parsing ${s3Key}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log("=== Populate Track Durations ===");
  if (isDryRun) console.log("(Dry run — no DB updates)");
  if (limit) console.log(`Processing up to ${limit} tracks`);
  if (prefix) console.log(`Filtering s3Key prefix: ${prefix}`);
  if (bucketOverride) console.log(`Using bucket: ${bucketOverride}`);
  console.log(`Concurrency: ${concurrency}\n`);

  // Find all tracks with duration 0 and a valid s3Key
  const conditions = [eq(tracks.durationSeconds, 0), isNotNull(tracks.s3Key)];
  if (prefix) {
    conditions.push(like(tracks.s3Key, `${prefix}%`));
  }
  const baseQuery = db
    .select({
      id: tracks.id,
      title: tracks.title,
      s3Key: tracks.s3Key,
      fileSizeBytes: tracks.fileSizeBytes,
      durationSeconds: tracks.durationSeconds,
    })
    .from(tracks)
    .where(and(...conditions));

  const results = limit ? await baseQuery.limit(limit) : await baseQuery;

  console.log(`Found ${results.length} tracks with duration = 0\n`);

  if (results.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let updated = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);

    const promises = batch.map(async (track, batchIdx) => {
      const idx = i + batchIdx + 1;

      if (!track.s3Key) {
        failed++;
        return;
      }

      const duration = await getTrackDuration(
        track.s3Key,
        track.fileSizeBytes,
      );

      if (duration && duration > 0) {
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        console.log(
          `[${idx}/${results.length}] ✓ ${track.title} → ${mins}m${secs}s (${duration}s)`,
        );

        if (!isDryRun) {
          await db
            .update(tracks)
            .set({
              durationSeconds: duration,
              updatedAt: new Date(),
            })
            .where(eq(tracks.id, track.id));
        }
        updated++;
      } else {
        console.log(
          `[${idx}/${results.length}] ✗ ${track.title} — could not determine duration`,
        );
        failed++;
      }
    });

    await Promise.all(promises);
  }

  console.log(`\n=== Results ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Total:   ${results.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
