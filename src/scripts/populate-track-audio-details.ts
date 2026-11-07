/**
 * Populate track audio details (bit rate, sample rate, channels) by reading
 * the audio headers from S3.
 *
 * Uses HTTP Range requests to fetch only the first ~512KB of each file and
 * lets music-metadata parse the headers (same approach as
 * populate-track-durations.ts). Only tracks with an s3Key whose three detail
 * columns are all NULL are processed, so the script is safe to re-run.
 *
 * Usage:
 *   bun run src/scripts/populate-track-audio-details.ts                # full run
 *   bun run src/scripts/populate-track-audio-details.ts --dry-run      # print what would be written, change nothing
 *   bun run src/scripts/populate-track-audio-details.ts --limit 10     # process first N
 *   bun run src/scripts/populate-track-audio-details.ts --concurrency 3  # parallel requests
 *   bun run src/scripts/populate-track-audio-details.ts --prefix events/20250417  # filter by s3Key prefix
 *   bun run src/scripts/populate-track-audio-details.ts --bucket padmakara-pt-app  # override S3 bucket
 */

import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eq, and, isNotNull, isNull, like } from "drizzle-orm";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.ts";
import {
  describeAudioDetails,
  fetchAudioHead,
  readAudioDetails,
  type AudioDetails,
} from "../services/audio-details.ts";

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

async function getDetails(s3Key: string): Promise<AudioDetails | null> {
  try {
    const head = await fetchAudioHead(s3Key, getPresignedUrl);
    if (!head) {
      console.error(`  Could not fetch ${s3Key}`);
      return null;
    }
    return await readAudioDetails(head, s3Key);
  } catch (error: any) {
    console.error(`  Error reading ${s3Key}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log("=== Populate Track Audio Details ===");
  if (isDryRun) console.log("(Dry run — no DB updates)");
  if (limit) console.log(`Processing up to ${limit} tracks`);
  if (prefix) console.log(`Filtering s3Key prefix: ${prefix}`);
  if (bucketOverride) console.log(`Using bucket: ${bucketOverride}`);
  console.log(`Concurrency: ${concurrency}\n`);

  const conditions = [
    isNotNull(tracks.s3Key),
    isNull(tracks.bitrateKbps),
    isNull(tracks.sampleRateHz),
    isNull(tracks.channels),
  ];
  if (prefix) {
    conditions.push(like(tracks.s3Key, `${prefix}%`));
  }
  const baseQuery = db
    .select({ id: tracks.id, title: tracks.title, s3Key: tracks.s3Key })
    .from(tracks)
    .where(and(...conditions))
    .orderBy(tracks.id);

  const results = limit ? await baseQuery.limit(limit) : await baseQuery;

  console.log(`Found ${results.length} tracks without audio details\n`);

  if (results.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (track, batchIdx) => {
        const idx = i + batchIdx + 1;
        const details = track.s3Key ? await getDetails(track.s3Key) : null;

        if (!details) {
          console.log(`[${idx}/${results.length}] ✗ #${track.id} ${track.title} — no details found`);
          failed++;
          return;
        }

        console.log(
          `[${idx}/${results.length}] ✓ #${track.id} ${track.title} → ${describeAudioDetails(details)}` +
            (isDryRun ? " (dry run, not written)" : ""),
        );
        if (!isDryRun) {
          await db
            .update(tracks)
            .set({
              bitrateKbps: details.bitrateKbps,
              sampleRateHz: details.sampleRateHz,
              channels: details.channels,
            })
            .where(eq(tracks.id, track.id));
        }
        updated++;
      }),
    );
  }

  console.log(`\n=== Results ===`);
  console.log(`${isDryRun ? "Would update" : "Updated"}: ${updated}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Total:   ${results.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
