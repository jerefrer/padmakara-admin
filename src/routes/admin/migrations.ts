/**
 * Migration Management API Routes
 *
 * Handles the complete migration workflow:
 * 1. Upload CSV
 * 2. Analyze and catalog all files
 * 3. Save per-file decisions
 * 4. Execute migration
 * 5. Monitor progress
 */

import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/index.ts";
import {
  migrations,
  migrationFileCatalogs,
  migrationFileDecisions,
  migrationLogs,
  mediaFiles,
} from "../../db/schema/index.ts";
import { eq, desc } from "drizzle-orm";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { streamSSE } from "hono/streaming";
import type { EventSummary } from "../../scripts/html-report-generator.ts";

const app = new Hono();

// Auth + admin middleware already applied by parent admin router

// ============================================================================
// Validation Schemas
// ============================================================================

const uploadSchema = z.object({
  title: z.string().min(1, "Title is required"),
  notes: z.string().optional(),
});

const fileDecisionSchema = z.object({
  catalogId: z.number(),
  action: z.enum(["include", "ignore", "rename", "review"]),
  newFilename: z.string().optional(),
  targetCategory: z.enum([
    "audio_main",
    "audio_translation",
    "audio_legacy",
    "video",
    "transcript",
    "document",
    "image",
    "archive",
    "other",
  ]).optional(),
  notes: z.string().optional(),
});

const batchDecisionsSchema = z.object({
  decisions: z.array(fileDecisionSchema),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /admin/migrations
 * List all migrations with pagination
 */
const migrationColumns: Record<string, any> = {
  id: migrations.id,
  title: migrations.title,
  status: migrations.status,
  createdAt: migrations.createdAt,
};

app.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, migrationColumns) ?? desc(migrations.createdAt);

  const [data, total] = await Promise.all([
    db.select().from(migrations).orderBy(orderBy).limit(limit).offset(offset),
    countRows(migrations),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "migrations");
});

/**
 * POST /admin/migrations/upload
 * Upload CSV file and create migration session
 */
app.post("/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const csvFile = formData.get("csv") as File;
    const title = formData.get("title") as string;
    const notes = formData.get("notes") as string | null;

    if (!csvFile) {
      return c.json({ error: "CSV file is required" }, 400);
    }

    if (!title) {
      return c.json({ error: "Migration title is required" }, 400);
    }

    // Create uploads directory if it doesn't exist
    const uploadsDir = join(process.cwd(), "uploads", "migrations");
    if (!existsSync(uploadsDir)) {
      await mkdir(uploadsDir, { recursive: true });
    }

    // Save CSV file
    const timestamp = Date.now();
    const filename = `migration-${timestamp}-${csvFile.name}`;
    const filepath = join(uploadsDir, filename);

    const arrayBuffer = await csvFile.arrayBuffer();
    await writeFile(filepath, Buffer.from(arrayBuffer));

    // Count CSV rows (simple line count)
    const csvContent = Buffer.from(arrayBuffer).toString("utf-8");
    const rowCount = csvContent.split("\n").filter(line => line.trim()).length - 1; // -1 for header

    // Create migration record
    const [migration] = await db
      .insert(migrations)
      .values({
        title,
        csvFilePath: filepath,
        csvRowCount: rowCount,
        status: "uploaded",
        targetBucket: "padmakara-pt-app",
        notes: notes || null,
        createdBy: c.get("userId"),
      })
      .returning();

    return c.json({
      success: true,
      migration,
    }, 201);
  } catch (error: any) {
    console.error("Upload error:", error);
    return c.json({ error: error.message || "Upload failed" }, 500);
  }
});

/**
 * POST /admin/migrations/:id/analyze
 * Analyze CSV and catalog all S3 files
 */
app.post("/:id/analyze", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  try {
    // Get migration
    const [migration] = await db
      .select()
      .from(migrations)
      .where(eq(migrations.id, migrationId));

    if (!migration) {
      return c.json({ error: "Migration not found" }, 404);
    }

    if (migration.status !== "uploaded") {
      return c.json({ error: "Migration already analyzed" }, 400);
    }

    // Update status to analyzing
    await db
      .update(migrations)
      .set({ status: "analyzing" })
      .where(eq(migrations.id, migrationId));

    // TODO: This should be a background job
    // For now, we'll import and run the analysis synchronously
    // In production, use BullMQ or similar

    const { parseWixCSV, analyzeAndCatalog } = await import("../../scripts/migration-analyzer.ts");

    // Parse CSV
    const csvData = await parseWixCSV(migration.csvFilePath);

    // Analyze and catalog files (searches in old bucket via S3 prefix discovery)
    const analysis = await analyzeAndCatalog(migrationId, csvData, "padmakara-pt");

    // Since the analyzer auto-generates decisions for obvious cases,
    // set status to decisions_pending (admin can review and tweak)
    await db
      .update(migrations)
      .set({
        status: "decisions_pending",
        analysisData: analysis as any,
        analyzedAt: new Date(),
      })
      .where(eq(migrations.id, migrationId));

    return c.json({
      success: true,
      analysis,
    });
  } catch (error: any) {
    console.error("Analysis error:", error);

    // Update migration status to failed
    await db
      .update(migrations)
      .set({ status: "failed" })
      .where(eq(migrations.id, migrationId));

    return c.json({ error: error.message || "Analysis failed" }, 500);
  }
});

/**
 * GET /admin/migrations/:id
 * Get migration details with file catalogs
 */
app.get("/:id", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  const [migration] = await db
    .select()
    .from(migrations)
    .where(eq(migrations.id, migrationId));

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  // Get file catalogs
  const catalogs = await db
    .select()
    .from(migrationFileCatalogs)
    .where(eq(migrationFileCatalogs.migrationId, migrationId));

  // Format for frontend
  const formattedCatalogs = catalogs.map((file) => ({
    id: file.id,
    eventCode: file.eventCode,
    s3Directory: file.s3Directory,
    filename: file.filename,
    s3Key: file.s3Key,
    fileType: file.fileType,
    category: file.category,
    extension: file.extension,
    fileSize: file.fileSize,
    mimeType: file.mimeType,
    suggestedAction: file.suggestedAction,
    suggestedCategory: file.suggestedCategory,
    conflicts: file.conflicts || [],
    metadata: file.metadata || {},
  }));

  // Group by event
  const eventGroups = formattedCatalogs.reduce((acc, file) => {
    if (!acc[file.eventCode]) {
      acc[file.eventCode] = {
        eventCode: file.eventCode,
        s3Directory: file.s3Directory,
        files: [],
      };
    }
    acc[file.eventCode].files.push(file);
    return acc;
  }, {} as Record<string, { eventCode: string; s3Directory: string; files: any[] }>);

  return c.json({
    ...migration,
    events: Object.values(eventGroups),
    totalFiles: formattedCatalogs,
  });
});

/**
 * POST /admin/migrations/:id/decisions
 * Save file decision (single or batch)
 */
app.post("/:id/decisions", async (c) => {
  const migrationId = parseInt(c.req.param("id"));
  const userId = c.get("userId");

  try {
    const body = await c.req.json();
    const { decisions } = batchDecisionsSchema.parse(body);

    // Insert or update decisions
    const results = await Promise.all(
      decisions.map(async (decision) => {
        // Check if decision already exists
        const existing = await db
          .select()
          .from(migrationFileDecisions)
          .where(eq(migrationFileDecisions.catalogId, decision.catalogId));

        if (existing.length > 0) {
          // Update existing
          const [updated] = await db
            .update(migrationFileDecisions)
            .set({
              action: decision.action,
              newFilename: decision.newFilename || null,
              targetCategory: decision.targetCategory || null,
              notes: decision.notes || null,
              decidedBy: userId,
              decidedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(migrationFileDecisions.catalogId, decision.catalogId))
            .returning();
          return updated;
        } else {
          // Insert new
          const [inserted] = await db
            .insert(migrationFileDecisions)
            .values({
              migrationId,
              catalogId: decision.catalogId,
              action: decision.action,
              newFilename: decision.newFilename || null,
              targetCategory: decision.targetCategory || null,
              notes: decision.notes || null,
              decidedBy: userId,
            })
            .returning();
          return inserted;
        }
      })
    );

    // Check if all files have decisions
    const totalFiles = await db
      .select({ count: migrationFileCatalogs.id })
      .from(migrationFileCatalogs)
      .where(eq(migrationFileCatalogs.migrationId, migrationId));

    const decidedFiles = await db
      .select({ count: migrationFileDecisions.id })
      .from(migrationFileDecisions)
      .where(eq(migrationFileDecisions.migrationId, migrationId));

    // Update migration status
    if (decidedFiles.length === totalFiles.length) {
      await db
        .update(migrations)
        .set({ status: "decisions_complete" })
        .where(eq(migrations.id, migrationId));
    } else if (decidedFiles.length > 0) {
      await db
        .update(migrations)
        .set({ status: "decisions_pending" })
        .where(eq(migrations.id, migrationId));
    }

    return c.json({
      success: true,
      decisions: results,
      progress: {
        total: totalFiles.length,
        decided: decidedFiles.length,
        percentage: Math.round((decidedFiles.length / totalFiles.length) * 100),
      },
    });
  } catch (error: any) {
    console.error("Decision save error:", error);
    return c.json({ error: error.message || "Failed to save decisions" }, 500);
  }
});

/**
 * GET /admin/migrations/:id/decisions
 * Get all decisions for a migration
 */
app.get("/:id/decisions", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  const decisions = await db
    .select()
    .from(migrationFileDecisions)
    .where(eq(migrationFileDecisions.migrationId, migrationId));

  return c.json({ decisions });
});

/**
 * POST /admin/migrations/:id/approve
 * Approve migration for execution
 */
app.post("/:id/approve", async (c) => {
  const migrationId = parseInt(c.req.param("id"));
  const userId = c.get("userId");

  const [migration] = await db
    .select()
    .from(migrations)
    .where(eq(migrations.id, migrationId));

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  if (migration.status !== "decisions_complete" && migration.status !== "decisions_pending" && migration.status !== "analyzed") {
    return c.json({ error: "Migration must have decisions before approval" }, 400);
  }

  await db
    .update(migrations)
    .set({
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
    })
    .where(eq(migrations.id, migrationId));

  return c.json({ success: true });
});

/**
 * POST /admin/migrations/:id/execute
 * Execute migration (background job)
 */
app.post("/:id/execute", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  const [migration] = await db
    .select()
    .from(migrations)
    .where(eq(migrations.id, migrationId));

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  if (migration.status !== "approved") {
    return c.json({ error: "Migration must be approved before execution" }, 400);
  }

  // Update status
  await db
    .update(migrations)
    .set({
      status: "executing",
      executionStartedAt: new Date(),
      progressPercentage: 0,
    })
    .where(eq(migrations.id, migrationId));

  // Start execution in background (fire-and-forget)
  const { executeMigration } = await import("../../scripts/migration-executor.ts");
  executeMigration(migrationId, "padmakara-pt", migration.targetBucket)
    .catch(async (err) => {
      console.error(`Migration ${migrationId} failed:`, err);
      await db.update(migrations).set({
        status: "failed",
        executionCompletedAt: new Date(),
      }).where(eq(migrations.id, migrationId));
    });

  return c.json({
    success: true,
    message: "Migration execution started",
    migrationId,
  });
});

/**
 * GET /admin/migrations/:id/progress
 * SSE stream for real-time progress updates
 */
app.get("/:id/progress", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  return streamSSE(c, async (stream) => {
    // Send initial status
    const [migration] = await db
      .select()
      .from(migrations)
      .where(eq(migrations.id, migrationId));

    if (!migration) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "Migration not found" }),
      });
      return;
    }

    await stream.writeSSE({
      event: "progress",
      data: JSON.stringify({
        status: migration.status,
        percentage: migration.progressPercentage,
        processedEvents: migration.processedEvents,
        successfulEvents: migration.successfulEvents,
        failedEvents: migration.failedEvents,
      }),
    });

    // Poll for updates every 1 second
    const interval = setInterval(async () => {
      const [updated] = await db
        .select()
        .from(migrations)
        .where(eq(migrations.id, migrationId));

      if (!updated) {
        clearInterval(interval);
        return;
      }

      await stream.writeSSE({
        event: "progress",
        data: JSON.stringify({
          status: updated.status,
          percentage: updated.progressPercentage,
          processedEvents: updated.processedEvents,
          successfulEvents: updated.successfulEvents,
          failedEvents: updated.failedEvents,
          skippedEvents: updated.skippedEvents,
        }),
      });

      // Stop if completed or failed
      if (updated.status === "completed" || updated.status === "failed") {
        await stream.writeSSE({
          event: "complete",
          data: JSON.stringify({
            status: updated.status,
            completedAt: updated.executionCompletedAt,
          }),
        });
        clearInterval(interval);
        stream.close();
      }
    }, 1000);

    // Cleanup on client disconnect
    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(interval);
    });
  });
});

/**
 * GET /admin/migrations/:id/logs
 * Get migration logs with filtering
 */
app.get("/:id/logs", async (c) => {
  const migrationId = parseInt(c.req.param("id"));
  const level = c.req.query("level"); // optional filter
  const limit = parseInt(c.req.query("limit") || "100");

  let query = db
    .select()
    .from(migrationLogs)
    .where(eq(migrationLogs.migrationId, migrationId))
    .orderBy(desc(migrationLogs.timestamp))
    .limit(limit);

  if (level) {
    // @ts-ignore - dynamic where clause
    query = query.where(eq(migrationLogs.level, level));
  }

  const logs = await query;

  return c.json({ logs });
});

/**
 * DELETE /admin/migrations/:id
 * Delete migration (soft delete - mark as cancelled)
 */
app.delete("/:id", async (c) => {
  const migrationId = parseInt(c.req.param("id"));

  const [migration] = await db
    .select()
    .from(migrations)
    .where(eq(migrations.id, migrationId));

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  if (migration.status === "executing") {
    return c.json({ error: "Cannot delete a running migration" }, 400);
  }

  await db
    .update(migrations)
    .set({ status: "cancelled" })
    .where(eq(migrations.id, migrationId));

  return c.json({ success: true });
});

export default app;
