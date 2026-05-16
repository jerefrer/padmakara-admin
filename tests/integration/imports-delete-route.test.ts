import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs, importFiles } from "../../src/db/schema/index.ts";
import { errorHandler } from "../../src/lib/errors.ts";

import importRoutes from "../../src/routes/admin/migrations.ts";

const app = new Hono();
app.route("/", importRoutes);
app.onError(errorHandler);

const EVENT_CODE = "EV-DELETE-ROUTE";

describe("DELETE /admin/imports/:id", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request("/abc", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown job id", async () => {
    const res = await app.request("/99999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes the job row and cascades to import_files, returns the deleted job", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "cataloged" })
      .returning();
    await db.insert(importFiles).values([
      {
        importJobId: job!.id,
        sourceS3Key: "s/1.mp3",
        filename: "001 JKR - A.mp3",
        extension: ".mp3",
        category: "audio1",
      },
      {
        importJobId: job!.id,
        sourceS3Key: "s/2.mp3",
        filename: "002 JKR - B.mp3",
        extension: ".mp3",
        category: "audio1",
      },
    ]);

    const res = await app.request(`/${job!.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: number; eventCode: string };
    expect(body.id).toBe(job!.id);
    expect(body.eventCode).toBe(EVENT_CODE);

    // The job row must be gone
    const remainingJobs = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job!.id));
    expect(remainingJobs).toHaveLength(0);

    // The child import_files rows must also be gone (ON DELETE CASCADE)
    const remainingFiles = await db
      .select()
      .from(importFiles)
      .where(eq(importFiles.importJobId, job!.id));
    expect(remainingFiles).toHaveLength(0);
  });
});
