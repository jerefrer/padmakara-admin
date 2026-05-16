import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, type Column } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { importJobs, importFiles } from "../../db/schema/index.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { catalogEvent } from "../../services/event-import.ts";
import { loadInventory, flattenInventoryEvent } from "../../services/import-inventory.ts";
import {
  proposeStructure,
  confirmStructure,
  refineStructure,
  proposedStructureSchema,
} from "../../services/import-inference.ts";
import { executeImport } from "../../services/import-executor.ts";
import { AppError } from "../../lib/errors.ts";

const app = new Hono();

const catalogSchema = z.object({ eventCode: z.string().min(1) });

const refineRequestSchema = z.object({
  structure: proposedStructureSchema,
  instruction: z.string().min(1),
});

const importColumns: Record<string, Column> = {
  id: importJobs.id,
  eventCode: importJobs.eventCode,
  status: importJobs.status,
  createdAt: importJobs.createdAt,
};

/** GET /admin/migrations — list import jobs (React-admin compatible). */
app.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, importColumns) ?? desc(importJobs.createdAt);
  const [data, total] = await Promise.all([
    db.select().from(importJobs).orderBy(orderBy).limit(limit).offset(offset),
    countRows(importJobs),
  ]);
  return listResponse(c, data, total, offset, offset + limit, "imports");
});

/** GET /admin/migrations/available — inventory events not yet cataloged. */
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

/**
 * POST /admin/migrations/catalog — catalog one event's source files.
 * A ZodError (bad body) or AppError (unknown / already-imported event)
 * propagates to the global errorHandler.
 */
app.post("/catalog", async (c) => {
  const { eventCode } = catalogSchema.parse(await c.req.json());
  const job = await catalogEvent(eventCode);
  return c.json(job, 201);
});

/** DELETE /admin/migrations/:id — remove an import job (cascades to import_files). */
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const [deleted] = await db
    .delete(importJobs)
    .where(eq(importJobs.id, id))
    .returning();
  if (!deleted) {
    throw AppError.notFound(`Import job ${id} not found`);
  }
  return c.json(deleted);
});

/**
 * POST /admin/migrations/:id/propose — run AI session inference for a cataloged
 * job and store the proposed structure. Errors propagate to the global
 * errorHandler (unknown job → 404, wrong status → 400, AI failure → 500).
 */
app.post("/:id/propose", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const job = await proposeStructure(id);
  return c.json(job);
});

/**
 * POST /admin/migrations/:id/confirm — store a human-reviewed structure.
 * Body: a ProposedStructure. A ZodError (bad body) or AppError propagates
 * to the global errorHandler.
 */
app.post("/:id/confirm", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const structure = proposedStructureSchema.parse(await c.req.json());
  const job = await confirmStructure(id, structure);
  return c.json(job);
});

/**
 * POST /admin/migrations/:id/refine — ask the AI to adjust the structure per a
 * plain-language instruction. Body: { structure: ProposedStructure, instruction }.
 */
app.post("/:id/refine", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const { structure, instruction } = refineRequestSchema.parse(
    await c.req.json(),
  );
  const job = await refineStructure(id, structure, instruction);
  return c.json(job);
});

/**
 * POST /admin/migrations/:id/execute — run the server-side import for a reviewed
 * job: copy/extract its audio and create the real event. Errors propagate to
 * the global errorHandler.
 */
app.post("/:id/execute", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const job = await executeImport(id);
  return c.json(job);
});

/** GET /admin/migrations/:id — an import job with its cataloged files. */
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw AppError.badRequest("Invalid import job ID", "VALIDATION_ERROR");
  }
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  if (!job) {
    throw AppError.notFound("Import job not found");
  }
  const files = await db
    .select()
    .from(importFiles)
    .where(eq(importFiles.importJobId, id));
  return c.json({ ...job, files });
});

export default app;
