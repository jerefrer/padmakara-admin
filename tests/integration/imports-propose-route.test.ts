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

import importRoutes from "../../src/routes/admin/imports.ts";

const app = new Hono();
app.route("/", importRoutes);
app.onError(errorHandler);

const EVENT_CODE = "EV-PROPOSE-ROUTE";

describe("POST /admin/imports/:id/propose", () => {
  beforeEach(async () => {
    await db.delete(importJobs).where(eq(importJobs.eventCode, EVENT_CODE));
    mockClaude.text = "";
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request("/abc/propose", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await app.request("/99999999/propose", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("proposes a structure and returns the updated job", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({ eventCode: EVENT_CODE, status: "cataloged" })
      .returning();
    const files = await db
      .insert(importFiles)
      .values([
        { importJobId: job!.id, sourceS3Key: "s/1.mp3", filename: "001 JKR - A.mp3", extension: ".mp3", category: "audio1" },
        { importJobId: job!.id, sourceS3Key: "s/2.mp3", filename: "002 JKR - B.mp3", extension: ".mp3", category: "audio1" },
      ])
      .returning();
    mockClaude.text = JSON.stringify({
      sessions: [
        {
          sessionNumber: 1,
          titleEn: "S1",
          sessionDate: null,
          timePeriod: "morning",
          importFileIds: files.map((f) => f.id),
        },
      ],
    });

    const res = await app.request(`/${job!.id}/propose`, { method: "POST" });
    expect(res.status).toBe(200);
    // the route returns the updated importJobs row
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("proposed");
  });
});
