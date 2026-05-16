import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs, importFiles, events } from "../../src/db/schema/index.ts";
import { errorHandler } from "../../src/lib/errors.ts";

vi.mock("../../src/services/s3.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/s3.ts")>();
  return { ...actual, copyObjectIntoAppBucket: vi.fn(async () => {}) };
});
vi.mock("../../src/services/zip-extractor.ts", () => ({
  extractZip: vi.fn(async () => ({ extractedFiles: 0, skippedFiles: 0 })),
}));

import importRoutes from "../../src/routes/admin/imports.ts";

const app = new Hono();
app.route("/", importRoutes);
app.onError(errorHandler);

const EVENT_CODE = "EV-EXECUTE-ROUTE";

describe("POST /admin/imports/:id/execute", () => {
  beforeEach(async () => {
    await db.delete(events).where(eq(events.eventCode, EVENT_CODE));
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request("/abc/execute", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await app.request("/99999999/execute", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("executes a reviewed job and returns the completed job", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "reviewed" })
      .returning();
    const files = await db
      .insert(importFiles)
      .values([
        { importJobId: job!.id, sourceS3Key: "s/a.mp3", filename: "001 JKR - A.mp3", extension: ".mp3", category: "audio1" },
      ])
      .returning();
    await db
      .update(importJobs)
      .set({
        confirmedStructure: {
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "S1",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [
                { importFileId: files[0]!.id, trackNumber: 1, title: "A", speaker: "JKR", languages: ["en"], originalLanguage: "en", isTranslation: false },
              ],
            },
          ],
        },
      })
      .where(eq(importJobs.id, job!.id));

    const res = await app.request(`/${job!.id}/execute`, { method: "POST" });
    expect(res.status).toBe(200);
    // route returns the updated importJobs row
    const body = (await res.json()) as { status: string; retreatId: number | null };
    expect(body.status).toBe("completed");
    expect(body.retreatId).not.toBeNull();
  });
});
