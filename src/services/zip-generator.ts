import archiver from "archiver";
import { Readable } from "stream";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "../db/index.ts";
import { downloadRequests, events, sessions, tracks } from "../db/schema/index.ts";
import { eq, and } from "drizzle-orm";
import {
  getObjectStream,
  uploadFile,
  buildZipS3Key,
  buildTrackS3Key,
  generatePresignedDownloadUrl,
} from "./s3.ts";
import { buildConventionFilename } from "./track-filename.ts";

const ZIP_EXPIRY_HOURS = 24;

/** Convert a title to a filesystem-safe slug for ZIP filenames. */
function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")    // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "");       // trim leading/trailing hyphens
}
const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every N files

interface TrackInfo {
  id: number;
  title: string;
  s3Key: string;
  trackNumber: number;
  speaker: string | null;
  languages: string[];
  isTranslation: boolean;
  sessionTitle: string;
  sessionDate: string;
  timePeriod: string | null;
  partNumber: number | null;
}

/**
 * Append a single source stream to the archive and resolve once archiver has
 * fully consumed it (its "entry" event fires). This paces track processing so
 * only one S3 read stream is open at a time, keeping memory and open
 * connections bounded even for events with many tracks.
 */
function appendTrack(
  archive: archiver.Archiver,
  source: Readable,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      archive.removeListener("entry", onEntry);
      archive.removeListener("error", onError);
    };
    const onEntry = (entry: archiver.EntryData) => {
      if (entry.name === name) {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.append(source, { name });
  });
}

/**
 * Main function to generate ZIP file for a retreat/event
 */
export async function generateRetreatZip(
  requestId: string,
  eventId: number,
  userId?: number,
): Promise<void> {
  try {
    console.log(`[ZIP] Starting generation for request ${requestId}, event ${eventId}`);

    // Update status to processing
    await db
      .update(downloadRequests)
      .set({
        status: "processing",
        processingStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(downloadRequests.id, requestId));

    // Fetch event with all tracks
    const eventData = await db.query.events.findFirst({
      where: eq(events.id, eventId),
      with: {
        sessions: {
          with: {
            tracks: {
              orderBy: (tracks, { asc }) => [asc(tracks.trackNumber)],
            },
          },
          orderBy: (sessions, { asc }) => [asc(sessions.sessionDate)],
        },
      },
    });

    if (!eventData) {
      throw new Error(`Event ${eventId} not found`);
    }

    // Build flat list of tracks with session info
    const trackList: TrackInfo[] = [];
    for (const session of eventData.sessions) {
      for (const track of session.tracks) {
        if (track.s3Key) {
          trackList.push({
            id: track.id,
            title: track.title,
            s3Key: track.s3Key,
            trackNumber: track.trackNumber,
            speaker: track.speaker,
            languages: track.languages,
            isTranslation: track.isTranslation,
            sessionTitle: session.titleEn || `Session ${session.sessionNumber}`,
            sessionDate: session.sessionDate || "",
            timePeriod: session.timePeriod,
            partNumber: session.partNumber,
          });
        }
      }
    }

    if (trackList.length === 0) {
      throw new Error("No tracks found for this event");
    }

    console.log(`[ZIP] Found ${trackList.length} tracks to process`);

    // Update total files count
    await db
      .update(downloadRequests)
      .set({
        totalFiles: trackList.length,
        updatedAt: new Date(),
      })
      .where(eq(downloadRequests.id, requestId));

    // Resolve the destination key up front so the archive can be streamed
    // straight to S3 as it is built, instead of buffering the whole ZIP in
    // memory first.
    const eventCode = eventData.eventCode || `event-${eventId}`;
    const eventTitle = eventData.titleEn || eventData.titlePt || eventCode;
    const zipFilename = slugify(eventTitle);
    const zipS3Key = buildZipS3Key(eventCode, requestId, zipFilename);

    // Create the ZIP archive (a Readable stream) and pipe it directly into the
    // multipart S3 upload. lib-storage applies backpressure, so peak memory is
    // bounded by the part buffer (~partSize × queueSize), not the archive size.
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Compression level (0-9)
    });

    let fatalArchiveError: Error | null = null;
    archive.on("error", (err: Error) => {
      fatalArchiveError = err;
      console.error(`[ZIP] Archiver error for request ${requestId}:`, err);
    });
    archive.on("warning", (warn) => {
      console.warn(`[ZIP] Archiver warning for request ${requestId}:`, warn);
    });

    const tmpZipPath = join(tmpdir(), `zip-${requestId}.zip`);
    console.log(`[ZIP] Building archive to temp file: ${tmpZipPath}`);
    const zipFileStream = createWriteStream(tmpZipPath);
    const zipWriteClosed = new Promise<void>((resolve, reject) => {
      zipFileStream.on("close", () => resolve());
      zipFileStream.on("error", reject);
    });
    archive.pipe(zipFileStream);

    // Process each track. appendTrack waits until archiver has fully consumed
    // each source stream before the next is opened, so we hold at most one S3
    // read stream at a time — bounding both memory and open connections.
    let processedCount = 0;

    for (const track of trackList) {
      if (fatalArchiveError) break;
      try {
        console.log(`[ZIP] Processing track ${processedCount + 1}/${trackList.length}: ${track.title}`);

        // Download track from S3 as a stream and append it to the archive.
        // Entries live in one folder per session and are named after the
        // import naming convention (docs/NAMING-CONVENTIONS.md), rebuilt from
        // the CURRENT metadata — so a downloaded ZIP is re-importable as-is.
        const trackStream = await getObjectStream(track.s3Key);
        const filename = buildConventionFilename(
          {
            trackNumber: track.trackNumber,
            title: track.title,
            speaker: track.speaker,
            languages: track.languages,
            isTranslation: track.isTranslation,
            s3Key: track.s3Key,
          },
          {
            sessionDate: track.sessionDate || null,
            timePeriod: track.timePeriod,
            partNumber: track.partNumber,
          },
        );
        const zipEntryName = `${track.sessionDate} - ${track.sessionTitle}/${filename}`;
        await appendTrack(archive, trackStream, zipEntryName);

        processedCount++;

        // Update progress periodically
        if (processedCount % PROGRESS_UPDATE_INTERVAL === 0 || processedCount === trackList.length) {
          const progressPercent = Math.floor((processedCount / trackList.length) * 100);
          await db
            .update(downloadRequests)
            .set({
              processedFiles: processedCount,
              progressPercent,
              updatedAt: new Date(),
            })
            .where(eq(downloadRequests.id, requestId));
        }
      } catch (trackError) {
        console.error(`[ZIP] Error processing track ${track.id}:`, trackError);
        // Continue with other tracks (don't fail entire ZIP for one missing track)
      }
    }

    // Finalize the archive and wait for it to fully flush to the temp file,
    // then upload the file to storage. Bun's Node streams can't be fed directly
    // to the AWS SDK's multipart uploader ("Body Data is unsupported format"),
    // so we stage the ZIP to disk and use Bun's native S3 client to stream the
    // file up (bounded memory, R2-native).
    await archive.finalize();
    await zipWriteClosed;

    if (fatalArchiveError) {
      throw fatalArchiveError;
    }

    const zipSize = archive.pointer();
    console.log(`[ZIP] Archive built (${zipSize} bytes). Uploading to ${zipS3Key}...`);
    try {
      await uploadFile(zipS3Key, tmpZipPath, "application/zip");
      console.log(`[ZIP] Uploaded ${zipS3Key}`);
    } finally {
      await unlink(tmpZipPath).catch(() => {});
    }

    // Generate presigned download URL (valid for 24 hours)
    const downloadUrl = await generatePresignedDownloadUrl(
      zipS3Key,
      ZIP_EXPIRY_HOURS * 3600,
    );

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + ZIP_EXPIRY_HOURS * 60 * 60 * 1000);

    // Update database with success
    await db
      .update(downloadRequests)
      .set({
        status: "ready",
        fileSize: zipSize,
        downloadUrl,
        s3Key: zipS3Key,
        processedFiles: processedCount,
        progressPercent: 100,
        processingCompletedAt: new Date(),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(downloadRequests.id, requestId));

    console.log(`[ZIP] Generation completed successfully for request ${requestId}`);
  } catch (error) {
    console.error(`[ZIP] Generation failed for request ${requestId}:`, error);

    // Update database with failure
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await db
      .update(downloadRequests)
      .set({
        status: "failed",
        errorMessage,
        processingCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(downloadRequests.id, requestId))
      .catch((dbError) => {
        console.error(`[ZIP] Failed to update error status:`, dbError);
      });

    throw error; // Re-throw for logging at route level
  }
}
