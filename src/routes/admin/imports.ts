import { Hono } from "hono";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { importJobs, importFiles } from "../../db/schema/index.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { catalogEvent } from "../../services/event-import.ts";
import { loadInventory, flattenInventoryEvent } from "../../services/import-inventory.ts";
import { AppError } from "../../lib/errors.ts";

const app = new Hono();

const catalogSchema = z.object({ eventCode: z.string().min(1) });

const importColumns: Record<string, any> = {
  id: importJobs.id,
  eventCode: importJobs.eventCode,
  status: importJobs.status,
  createdAt: importJobs.createdAt,
};

/** GET /admin/imports — list import jobs (React-admin compatible). */
app.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, importColumns) ?? desc(importJobs.createdAt);
  const [data, total] = await Promise.all([
    db.select().from(importJobs).orderBy(orderBy).limit(limit).offset(offset),
    countRows(importJobs),
  ]);
  return listResponse(c, data, total, offset, offset + limit, "imports");
});

/** GET /admin/imports/available — inventory events not yet cataloged. */
app.get("/available", async (c) => {
  const inventory = loadInventory();
  const jobs = await db.select({ eventCode: importJobs.eventCode }).from(importJobs);
  const taken = new Set(jobs.map((j) => j.eventCode));
  const events = inventory.events
    .filter((e) => !taken.has(e.canonicalCode))
    .map((e) => ({
      eventCode: e.canonicalCode,
      matchStatus: e.matchStatus,
      fileCount: flattenInventoryEvent(e).length,
    }));
  return c.json({ events, total: events.length });
});

/** POST /admin/imports/catalog — catalog one event's source files. */
app.post("/catalog", async (c) => {
  try {
    const { eventCode } = catalogSchema.parse(await c.req.json());
    const job = await catalogEvent(eventCode);
    return c.json(job, 201);
  } catch (err) {
    if (err instanceof AppError) {
      // AppError.statusCode is a valid HTTP status; Hono's typed status arg needs the assertion
      return c.json({ error: err.message, code: err.code }, err.statusCode as any);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "Validation error", code: "VALIDATION_ERROR" }, 400);
    }
    console.error("Catalog error:", err);
    return c.json({ error: "Catalog failed", code: "INTERNAL_ERROR" }, 500);
  }
});

/** GET /admin/imports/:id — an import job with its cataloged files. */
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    return c.json(
      { error: "Invalid import job ID", code: "VALIDATION_ERROR" },
      400,
    );
  }
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  if (!job) {
    return c.json({ error: "Import job not found", code: "NOT_FOUND" }, 404);
  }
  const files = await db.select().from(importFiles).where(eq(importFiles.importJobId, id));
  return c.json({ ...job, files });
});

export default app;
