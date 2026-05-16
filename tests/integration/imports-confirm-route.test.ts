import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs } from "../../src/db/schema/index.ts";
import { errorHandler } from "../../src/lib/errors.ts";
import importRoutes from "../../src/routes/admin/imports.ts";

const app = new Hono();
app.route("/", importRoutes);
app.onError(errorHandler);

const EVENT_CODE = "EV-CONFIRM-ROUTE";

function validStructure(importFileId: number) {
  return {
    sessions: [
      {
        sessionNumber: 1,
        titleEn: "Morning",
        sessionDate: "2024-04-25",
        timePeriod: "morning",
        tracks: [
          {
            importFileId,
            trackNumber: 1,
            title: "Opening",
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: "001 JKR - Opening.mp3",
          },
        ],
      },
    ],
  };
}

describe("POST /admin/imports/:id/confirm", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request("/abc/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validStructure(1)),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed structure body", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "proposed" })
      .returning();
    const res = await app.request(`/${job!.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("stores the confirmed structure and sets status reviewed", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "proposed" })
      .returning();
    const res = await app.request(`/${job!.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validStructure(42)),
    });
    expect(res.status).toBe(200);
    // route returns the updated importJobs row
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("reviewed");

    const [reloaded] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job!.id));
    expect(reloaded?.confirmedStructure).not.toBeNull();
  });

  it("rejects confirming a job that is not proposed or reviewed", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "completed" })
      .returning();
    const res = await app.request(`/${job!.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validStructure(1)),
    });
    expect(res.status).toBe(400);
  });
});
