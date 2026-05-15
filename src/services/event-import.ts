import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { importJobs, importFiles } from "../db/schema/index.ts";
import { AppError } from "../lib/errors.ts";
import {
  loadInventory,
  findInventoryEvent,
  flattenInventoryEvent,
} from "./import-inventory.ts";

/**
 * Catalog one legacy event: read its source files from the S3 inventory and
 * record them in `import_files`, creating (or re-using) the `import_jobs`
 * row. Idempotent — re-cataloging replaces the file list. Throws if the
 * event is unknown or already imported.
 */
export async function catalogEvent(eventCode: string) {
  const inventoryEvent = findInventoryEvent(loadInventory(), eventCode);
  if (!inventoryEvent) {
    throw AppError.notFound(`Event ${eventCode} not found in S3 inventory`);
  }

  const descriptors = flattenInventoryEvent(inventoryEvent);

  const [existing] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.eventCode, eventCode));

  let jobId: number;
  if (existing) {
    if (existing.status === "completed") {
      throw AppError.conflict(`Event ${eventCode} has already been imported`);
    }
    jobId = existing.id;
    await db.delete(importFiles).where(eq(importFiles.importJobId, jobId));
  } else {
    // insert ... returning() yields exactly the one inserted row
    const [created] = await db
      .insert(importJobs)
      .values({ eventCode })
      .returning();
    jobId = created!.id;
  }

  if (descriptors.length > 0) {
    await db.insert(importFiles).values(
      descriptors.map((d) => ({
        importJobId: jobId,
        sourceS3Key: d.sourceS3Key,
        zipEntryName: d.zipEntryName,
        filename: d.filename,
        extension: d.extension,
        sizeBytes: d.sizeBytes,
        category: d.category,
        language: d.language,
      })),
    );
  }

  // update ... returning() yields exactly the one updated row
  const [updated] = await db
    .update(importJobs)
    .set({
      status: "cataloged",
      fileCount: descriptors.length,
      catalogedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId))
    .returning();

  return updated!;
}
