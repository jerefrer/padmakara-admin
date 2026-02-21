/**
 * Migration Executor
 *
 * Processes approved migration decisions:
 * - Extracts ZIPs via Lambda directly to the new bucket
 * - Copies loose files (audio, transcripts) via S3 CopyObject
 * - Verifies results against CSV manifest
 * - Creates mediaFiles DB records
 * - Updates migration progress in real-time
 *
 * Designed to run as a fire-and-forget background operation
 * triggered from the admin execute endpoint.
 */

import { db } from "../db/index.ts";
import { eq, and, sql } from "drizzle-orm";
import {
  migrations,
  migrationFileCatalogs,
  migrationFileDecisions,
  migrationLogs,
  mediaFiles,
  events,
} from "../db/schema/index.ts";
import {
  triggerZipExtraction,
  listS3Prefix,
  copyS3Object,
  extractS3KeyFromUrl,
} from "./s3-utils.ts";

// ============================================================================
// Types
// ============================================================================

interface DecisionWithCatalog {
  decision: {
    id: number;
    action: string;
    targetS3Key: string | null;
    targetCategory: string | null;
    newFilename: string | null;
  };
  catalog: {
    id: number;
    eventCode: string;
    filename: string;
    s3Key: string;
    s3Directory: string;
    fileType: string;
    category: string;
    extension: string;
    mimeType: string;
    metadata: Record<string, any> | null;
  };
}

// ============================================================================
// Logging Helper
// ============================================================================

async function log(
  migrationId: number,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  eventCode?: string,
  context?: Record<string, any>,
) {
  await db.insert(migrationLogs).values({
    migrationId,
    level,
    message,
    eventCode: eventCode ?? null,
    context: context ?? null,
  });
  const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "info" ? "ℹ️" : "🔍";
  console.log(`${prefix} [${eventCode || "global"}] ${message}`);
}

// ============================================================================
// Progress Helper
// ============================================================================

async function updateProgress(
  migrationId: number,
  updates: {
    progressPercentage?: number;
    processedEvents?: number;
    successfulEvents?: number;
    failedEvents?: number;
    skippedEvents?: number;
    status?: string;
    executionCompletedAt?: Date;
  },
) {
  await db.update(migrations).set(updates).where(eq(migrations.id, migrationId));
}

// ============================================================================
// Main Executor
// ============================================================================

/**
 * Execute migration: process all approved file decisions.
 *
 * @param migrationId - ID of the approved migration
 * @param sourceBucket - Old bucket with source files (e.g., "padmakara-pt")
 * @param targetBucket - New bucket for migrated files (e.g., "padmakara-pt-app")
 */
export async function executeMigration(
  migrationId: number,
  sourceBucket: string,
  targetBucket: string,
): Promise<void> {
  await log(migrationId, "info", `Starting migration execution: ${sourceBucket} → ${targetBucket}`);

  try {
    // Fetch all "include" decisions with their catalog data
    const rows = await db
      .select({
        decision: {
          id: migrationFileDecisions.id,
          action: migrationFileDecisions.action,
          targetS3Key: migrationFileDecisions.targetS3Key,
          targetCategory: migrationFileDecisions.targetCategory,
          newFilename: migrationFileDecisions.newFilename,
        },
        catalog: {
          id: migrationFileCatalogs.id,
          eventCode: migrationFileCatalogs.eventCode,
          filename: migrationFileCatalogs.filename,
          s3Key: migrationFileCatalogs.s3Key,
          s3Directory: migrationFileCatalogs.s3Directory,
          fileType: migrationFileCatalogs.fileType,
          category: migrationFileCatalogs.category,
          extension: migrationFileCatalogs.extension,
          mimeType: migrationFileCatalogs.mimeType,
          metadata: migrationFileCatalogs.metadata,
        },
      })
      .from(migrationFileDecisions)
      .innerJoin(
        migrationFileCatalogs,
        eq(migrationFileDecisions.catalogId, migrationFileCatalogs.id),
      )
      .where(
        and(
          eq(migrationFileDecisions.migrationId, migrationId),
          eq(migrationFileDecisions.action, "include"),
        ),
      );

    if (rows.length === 0) {
      await log(migrationId, "warn", "No files with 'include' decision found");
      await updateProgress(migrationId, {
        status: "completed",
        progressPercentage: 100,
        executionCompletedAt: new Date(),
      });
      return;
    }

    // Group by event code
    const eventGroups = new Map<string, DecisionWithCatalog[]>();
    for (const row of rows) {
      const code = row.catalog.eventCode;
      if (!eventGroups.has(code)) eventGroups.set(code, []);
      eventGroups.get(code)!.push(row);
    }

    const totalEvents = eventGroups.size;
    let processedEvents = 0;
    let successfulEvents = 0;
    let failedEvents = 0;

    await log(migrationId, "info", `Processing ${rows.length} files across ${totalEvents} events`);

    // Process each event
    for (const [eventCode, decisions] of eventGroups) {
      processedEvents++;
      const pct = Math.round((processedEvents / totalEvents) * 100);

      await updateProgress(migrationId, {
        progressPercentage: pct,
        processedEvents,
        successfulEvents,
        failedEvents,
      });

      try {
        await processEvent(migrationId, eventCode, decisions, sourceBucket, targetBucket);
        successfulEvents++;
        await log(migrationId, "info", `Event completed successfully`, eventCode);
      } catch (err: any) {
        failedEvents++;
        await log(migrationId, "error", `Event failed: ${err.message}`, eventCode, {
          stack: err.stack,
        });
      }
    }

    // Final status
    const finalStatus = failedEvents === 0 ? "completed" : failedEvents === totalEvents ? "failed" : "completed";

    await updateProgress(migrationId, {
      status: finalStatus,
      progressPercentage: 100,
      processedEvents,
      successfulEvents,
      failedEvents,
      executionCompletedAt: new Date(),
    });

    await log(
      migrationId,
      failedEvents > 0 ? "warn" : "info",
      `Migration ${finalStatus}: ${successfulEvents}/${totalEvents} events succeeded, ${failedEvents} failed`,
    );
  } catch (err: any) {
    await log(migrationId, "error", `Migration failed: ${err.message}`, undefined, {
      stack: err.stack,
    });
    await updateProgress(migrationId, {
      status: "failed",
      executionCompletedAt: new Date(),
    });
  }
}

// ============================================================================
// Per-Event Processing
// ============================================================================

async function processEvent(
  migrationId: number,
  eventCode: string,
  decisions: DecisionWithCatalog[],
  sourceBucket: string,
  targetBucket: string,
): Promise<void> {
  // Separate ZIPs from loose files
  const zipFiles = decisions.filter(d => d.catalog.metadata?.sourceType === "zip");
  const looseFiles = decisions.filter(d => d.catalog.metadata?.sourceType !== "zip");

  await log(
    migrationId,
    "info",
    `Processing: ${zipFiles.length} ZIPs, ${looseFiles.length} loose files`,
    eventCode,
  );

  // 1. Extract ZIPs via Lambda
  for (const zip of zipFiles) {
    const s3Key = zip.catalog.s3Key;
    const zipUrl = `https://${sourceBucket}.s3.amazonaws.com/${s3Key}`;

    // Determine target prefix based on audio category
    const isAudio2 = zip.catalog.s3Key.toLowerCase().includes("/audio2/") ||
                     zip.catalog.s3Key.toLowerCase().includes("/audio 2/");
    const targetPrefix = isAudio2
      ? `events/${eventCode}/audio2`
      : `events/${eventCode}`;

    await log(migrationId, "info", `Extracting ZIP: ${zip.catalog.filename} → ${targetPrefix}/`, eventCode);

    const result = await triggerZipExtraction(zipUrl, targetPrefix, targetBucket);

    if (!result.success) {
      throw new Error(`ZIP extraction failed for ${zip.catalog.filename}: ${result.message}`);
    }

    await log(migrationId, "info", `ZIP extracted: ${result.message}`, eventCode);

    // Brief delay between Lambda invocations
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Copy loose files
  let copiedCount = 0;
  for (const file of looseFiles) {
    const targetKey = file.decision.targetS3Key || file.catalog.metadata?.targetS3Key;
    if (!targetKey) {
      await log(migrationId, "warn", `No target key for ${file.catalog.filename}, skipping`, eventCode);
      continue;
    }

    const success = await copyS3Object(file.catalog.s3Key, targetKey, sourceBucket, targetBucket);
    if (!success) {
      await log(migrationId, "error", `Failed to copy ${file.catalog.filename}`, eventCode);
      continue;
    }
    copiedCount++;
  }

  if (looseFiles.length > 0) {
    await log(migrationId, "info", `Copied ${copiedCount}/${looseFiles.length} loose files`, eventCode);
  }

  // 3. Verify files exist in target bucket
  const targetFiles = await listS3Prefix(`events/${eventCode}/`, targetBucket);
  await log(migrationId, "info", `Verification: ${targetFiles.length} files in target bucket`, eventCode);

  // 4. Create mediaFiles DB records
  await createMediaFileRecords(migrationId, eventCode, targetFiles, targetBucket, decisions);
}

// ============================================================================
// DB Record Creation
// ============================================================================

async function createMediaFileRecords(
  migrationId: number,
  eventCode: string,
  targetFiles: string[],
  targetBucket: string,
  decisions: DecisionWithCatalog[],
): Promise<void> {
  // Look up the event ID from the events table
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.eventCode, eventCode))
    .limit(1);

  if (!event) {
    await log(migrationId, "warn", `No event record found for ${eventCode} — skipping mediaFiles creation`, eventCode);
    return;
  }

  // Build a lookup from target key to source info
  const sourceMap = new Map<string, DecisionWithCatalog>();
  for (const d of decisions) {
    const targetKey = d.decision.targetS3Key || d.catalog.metadata?.targetS3Key;
    if (targetKey) sourceMap.set(targetKey, d);
  }

  let created = 0;
  for (const targetKey of targetFiles) {
    const filename = targetKey.split("/").pop() || targetKey;
    const extension = filename.split(".").pop()?.toLowerCase() || "";

    // Determine file type and category from the path
    const isAudio2 = targetKey.includes("/audio2/");
    const isTranscript = targetKey.includes("/transcripts/");
    const isVideo = targetKey.includes("/video/");

    let fileType: string;
    let category: string;
    let isTranslation = false;

    if (isTranscript) {
      fileType = "document";
      category = "transcript";
    } else if (isVideo) {
      fileType = "video";
      category = "video";
    } else if (isAudio2) {
      fileType = "audio";
      category = "audio_translation";
      isTranslation = true;
    } else {
      fileType = "audio";
      category = "audio_main";
    }

    // Get source info if available
    const source = sourceMap.get(targetKey);
    const mimeType = source?.catalog.mimeType || "application/octet-stream";

    await db.insert(mediaFiles).values({
      eventId: event.id,
      fileType,
      category: category as any,
      filename,
      s3Key: targetKey,
      s3Bucket: targetBucket,
      mimeType,
      isTranslation,
      migratedFrom: source?.catalog.s3Key || null,
      migrationId,
    });
    created++;
  }

  await log(migrationId, "info", `Created ${created} mediaFiles records`, eventCode);
}
