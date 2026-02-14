import archiver from "archiver";
import { Readable } from "stream";
import { db } from "../db/index.ts";
import { downloadRequests, events, sessions, tracks } from "../db/schema/index.ts";
import { eq, and } from "drizzle-orm";
import {
  getObjectStream,
  uploadStream,
  buildZipS3Key,
  buildTrackS3Key,
  generatePresignedDownloadUrl,
} from "./s3.ts";

const ZIP_EXPIRY_HOURS = 24;
const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every N files

interface TrackInfo {
  id: number;
  title: string;
  s3Key: string;
  trackNumber: number;
  sessionTitle: string;
  sessionDate: string;
}

/**
 * Main function to generate ZIP file for a retreat/event
 */
export async function generateRetreatZip(
  requestId: string,
  eventId: number,
  userId: number,
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
            sessionTitle: session.titleEn || `Session ${session.sessionNumber}`,
            sessionDate: session.sessionDate || "",
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

    // Create ZIP archive
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Compression level (0-9)
    });

    // Track ZIP output stream and size
    let zipSize = 0;
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      zipSize += chunk.length;
    });

    // Create readable stream from ZIP chunks
    const createZipStream = (): Readable => {
      const stream = new Readable({
        read() {
          if (chunks.length > 0) {
            this.push(chunks.shift());
          } else if (archive.pointer() > 0) {
            this.push(null); // End of stream
          }
        },
      });
      return stream;
    };

    // Process each track
    let processedCount = 0;

    for (const track of trackList) {
      try {
        console.log(`[ZIP] Processing track ${processedCount + 1}/${trackList.length}: ${track.title}`);

        // Download track from S3 as stream
        const trackStream = await getObjectStream(track.s3Key);

        // Add to ZIP with organized folder structure
        // Format: {SessionDate} - {SessionTitle}/Track {TrackNumber} - {Title}.mp3
        const zipEntryName = `${track.sessionDate} - ${track.sessionTitle}/Track ${track.trackNumber} - ${track.title}.mp3`;
        archive.append(trackStream, { name: zipEntryName });

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

    // Finalize ZIP
    await archive.finalize();

    console.log(`[ZIP] Archive finalized. Size: ${zipSize} bytes`);

    // Upload ZIP to S3
    const eventCode = eventData.eventCode || `event-${eventId}`;
    const zipS3Key = buildZipS3Key(eventCode, requestId);

    console.log(`[ZIP] Uploading to S3: ${zipS3Key}`);

    // Convert chunks to stream for upload
    const zipStream = Readable.from(Buffer.concat(chunks));
    await uploadStream(zipS3Key, zipStream, "application/zip");

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
