import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs, importFiles } from "../../src/db/schema/index.ts";
import type { Inventory } from "../../src/services/import-inventory.ts";

const mockSampleInventory: Inventory = {
  metadata: {},
  events: [
    {
      canonicalCode: "TEST-EVENT",
      s3Path: "mediateca/TEST-EVENT/",
      matchStatus: "matched",
      files: [
        {
          relativePath: "a.zip",
          s3Key: "mediateca/TEST-EVENT/a.zip",
          type: ".zip",
          size: 100,
          category: "audio1",
          zipContents: [
            { name: "x/01.mp3", uncompressedSize: 10, compressedSize: 9, type: ".mp3" },
            { name: "x/02.mp3", uncompressedSize: 20, compressedSize: 18, type: ".mp3" },
            { name: "x/03.mp3", uncompressedSize: 30, compressedSize: 27, type: ".mp3" },
          ],
        },
      ],
    },
  ],
};

// Replace only the file read; flatten/find stay real.
vi.mock("../../src/services/import-inventory.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/import-inventory.ts")>();
  return { ...actual, loadInventory: () => mockSampleInventory };
});

import { catalogEvent } from "../../src/services/event-import.ts";

describe("catalogEvent", () => {
  beforeEach(async () => {
    // Scope cleanup to this file's event code so it can run in parallel with
    // other integration tests that share the import_jobs table.
    await db
      .delete(importJobs)
      .where(eq(importJobs.eventCode, "TEST-EVENT")); // ON DELETE CASCADE clears import_files
  });

  it("throws when the event is absent from the inventory", async () => {
    await expect(catalogEvent("NO-SUCH-EVENT")).rejects.toThrow(/not found/i);
  });

  it("creates a cataloged job with one import_file per ZIP entry", async () => {
    const job = await catalogEvent("TEST-EVENT");

    expect(job.status).toBe("cataloged");
    expect(job.fileCount).toBe(3);
    expect(job.catalogedAt).not.toBeNull();

    const files = await db
      .select()
      .from(importFiles)
      .where(eq(importFiles.importJobId, job.id));
    expect(files).toHaveLength(3);
    expect(files[0]?.zipEntryName).toBe("x/01.mp3");
  });

  it("re-cataloging replaces the previous files without duplicating the job", async () => {
    const first = await catalogEvent("TEST-EVENT");
    const second = await catalogEvent("TEST-EVENT");

    expect(second.id).toBe(first.id);
    const files = await db
      .select()
      .from(importFiles)
      .where(eq(importFiles.importJobId, second.id));
    expect(files).toHaveLength(3);
  });

  it("throws conflict when the event has already been imported", async () => {
    await db
      .insert(importJobs)
      .values({ eventCode: "TEST-EVENT", status: "completed" });
    await expect(catalogEvent("TEST-EVENT")).rejects.toThrow(
      /already been imported/i,
    );
  });
});
