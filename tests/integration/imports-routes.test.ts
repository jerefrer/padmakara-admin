import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../src/db/index.ts";
import { importJobs } from "../../src/db/schema/index.ts";
import type { Inventory } from "../../src/services/import-inventory.ts";

const mockSampleInventory: Inventory = {
  metadata: {},
  events: [
    {
      canonicalCode: "EV-A",
      s3Path: "mediateca/EV-A/",
      matchStatus: "matched",
      files: [
        {
          relativePath: "a.mp3",
          s3Key: "mediateca/EV-A/a.mp3",
          type: ".mp3",
          size: 10,
          category: "audio1",
        },
      ],
    },
  ],
};

vi.mock("../../src/services/import-inventory.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/import-inventory.ts")>();
  return { ...actual, loadInventory: () => mockSampleInventory };
});

import app from "../../src/routes/admin/imports.ts";

describe("admin imports routes", () => {
  beforeEach(async () => {
    await db.delete(importJobs);
  });

  it("GET /available lists inventory events with no import job yet", async () => {
    const res = await app.request("/available");
    expect(res.status).toBe(200);
    // /available responds with { events, total }
    const body = (await res.json()) as {
      total: number;
      events: { eventCode: string; matchStatus: string; fileCount: number }[];
    };
    expect(body.total).toBe(1);
    expect(body.events[0]).toMatchObject({ eventCode: "EV-A", fileCount: 1 });
  });

  it("POST /catalog catalogs an event and returns the job", async () => {
    const res = await app.request("/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventCode: "EV-A" }),
    });
    expect(res.status).toBe(201);
    // /catalog responds with the cataloged importJobs row
    const job = (await res.json()) as { status: string; fileCount: number };
    expect(job.status).toBe("cataloged");
    expect(job.fileCount).toBe(1);
  });

  it("POST /catalog returns 404 for an unknown event", async () => {
    const res = await app.request("/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventCode: "NOPE" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /available excludes already-cataloged events", async () => {
    await app.request("/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventCode: "EV-A" }),
    });
    const res = await app.request("/available");
    // /available responds with { events, total }
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });
});
