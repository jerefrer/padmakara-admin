import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { importJobs, importFiles } from "../../src/db/schema/index.ts";
import { errorHandler } from "../../src/lib/errors.ts";

// Mutable holder for the mocked Claude response. `mock`-prefixed so the
// hoisted vi.mock factory may reference it. A real `function` (not an arrow)
// is used because the service calls `new Anthropic()`.
const mockClaude = { text: "" };

vi.mock("@anthropic-ai/sdk", () => ({
  default: function MockAnthropic() {
    return {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: mockClaude.text }],
        }),
      },
    };
  },
}));

import importRoutes from "../../src/routes/admin/migrations.ts";

const app = new Hono();
app.route("/", importRoutes);
app.onError(errorHandler);

const EVENT_CODE = "EV-REFINE-ROUTE";

describe("POST /admin/imports/:id/refine", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
    mockClaude.text = "";
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request("/abc/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structure: { sessions: [] }, instruction: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when instruction is missing from the body", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "proposed" })
      .returning();
    const res = await app.request(`/${job!.id}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // missing instruction field
      body: JSON.stringify({
        structure: {
          sessions: [
            {
              sessionNumber: 1,
              titleEn: "S",
              sessionDate: null,
              timePeriod: "morning",
              tracks: [],
            },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with status proposed on a happy-path refinement", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "proposed" })
      .returning();
    const files = await db
      .insert(importFiles)
      .values([
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
      ])
      .returning();

    // Current structure the client sends
    const currentStructure = {
      event: {
        titleEn: "Refine Route Retreat",
        titlePt: "",
        mainThemesEn: "",
        mainThemesPt: "",
        sessionThemesEn: "",
        sessionThemesPt: "",
        startDate: null,
        endDate: null,
        status: "draft",
        featuredAt: null,
        eventTypeId: null,
        audienceId: null,
        teacherIds: [],
        placeIds: [],
        groupIds: [],
      },
      transcripts: [],
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Original",
          sessionDate: null,
          timePeriod: "morning",
          tracks: files.map((f, i) => ({
            importFileId: f.id,
            trackNumber: i + 1,
            title: f.filename,
            speaker: null,
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
            originalFilename: f.filename,
          })),
        },
      ],
    };

    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "Refined",
          sessionDate: "2024-04-25",
          timePeriod: "morning",
          tracks: files.map((f, i) => ({
            importFileId: f.id,
            trackNumber: i + 1,
            title: `Refined Track ${i + 1}`,
            speaker: "JKR",
            languages: ["en"],
            originalLanguage: "en",
            isTranslation: false,
          })),
        },
      ],
    });

    const res = await app.request(`/${job!.id}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structure: currentStructure,
        instruction: "rename the session to Refined",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("proposed");
  });
});
