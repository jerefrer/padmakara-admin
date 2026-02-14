/**
 * Migration System Database Schema
 *
 * Tables for managing CSV → Database migration workflow:
 * - migrations: Migration sessions/runs
 * - migration_file_catalogs: All files found in S3 per event
 * - migration_file_decisions: User decisions per file
 * - migration_logs: Detailed execution logs
 * - media_files: Final migrated media files (all types)
 */

import { pgTable, serial, text, integer, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { events } from "./retreats.ts";

// ============================================================================
// Enums
// ============================================================================

export const migrationStatusEnum = pgEnum("migration_status", [
  "uploaded",      // CSV uploaded, not yet analyzed
  "analyzing",     // Analysis in progress
  "analyzed",      // Analysis complete, awaiting decisions
  "decisions_pending",  // Some decisions made, not all
  "decisions_complete", // All decisions made, ready to execute
  "approved",      // Approved for execution
  "executing",     // Migration running
  "completed",     // Successfully completed
  "failed",        // Failed with errors
  "cancelled",     // Cancelled by user
]);

export const fileActionEnum = pgEnum("file_action", [
  "include",   // Include in migration
  "ignore",    // Skip this file
  "rename",    // Include but rename
  "review",    // Needs manual review
]);

export const fileCategoryEnum = pgEnum("file_category", [
  "audio_main",         // Main audio tracks (bilingual)
  "audio_translation",  // Translation tracks (audio2)
  "audio_legacy",       // Legacy unique tracks
  "video",              // Video content
  "transcript",         // PDF transcripts
  "document",           // Other documents
  "image",              // Images
  "archive",            // ZIP/compressed files
  "other",              // Unknown/other types
]);

export const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

// ============================================================================
// Migration Sessions
// ============================================================================

export const migrations = pgTable("migrations", {
  id: serial("id").primaryKey(),

  // Basic info
  title: text("title").notNull(),  // User-provided title
  csvFilePath: text("csv_file_path").notNull(),  // Path to uploaded CSV
  csvRowCount: integer("csv_row_count"),  // Total rows in CSV

  // Status
  status: migrationStatusEnum("status").notNull().default("uploaded"),

  // Analysis results (JSONB for flexibility)
  analysisData: jsonb("analysis_data").$type<{
    totalEvents: number;
    validEvents: number;
    eventsWithAudio: number;
    eventsWithVideo: number;
    eventsWithoutMedia: number;
    totalAudioFiles: number;
    totalVideoFiles: number;
    totalDocuments: number;
    totalArchives: number;
    totalSize: number;
    // New fields for prefix-based discovery
    eventsWithZips: number;
    eventsWithLooseFiles: number;
    csvTrackMatches: number;
    csvTracksMissing: number;
    issues: Array<{
      severity: "error" | "warning" | "info";
      category: string;
      message: string;
      eventCode: string;
      details?: any;
    }>;
  }>(),

  // Execution settings (defaults from padmakara-pt-app)
  targetBucket: text("target_bucket").notNull().default("padmakara-pt-app"),

  // Progress tracking
  progressPercentage: integer("progress_percentage").default(0),
  processedEvents: integer("processed_events").default(0),
  successfulEvents: integer("successful_events").default(0),
  failedEvents: integer("failed_events").default(0),
  skippedEvents: integer("skipped_events").default(0),

  // Timing
  analyzedAt: timestamp("analyzed_at"),
  executionStartedAt: timestamp("execution_started_at"),
  executionCompletedAt: timestamp("execution_completed_at"),

  // Audit
  createdBy: integer("created_by").references(() => users.id),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),

  // Metadata
  notes: text("notes"),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// File Catalog (All files found in S3 per event)
// ============================================================================

export const migrationFileCatalogs = pgTable("migration_file_catalogs", {
  id: serial("id").primaryKey(),

  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),

  // Event info
  eventCode: text("event_code").notNull(),
  s3Directory: text("s3_directory").notNull(),

  // File info
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  fileType: text("file_type").notNull(),  // audio, video, document, image, archive, other
  category: fileCategoryEnum("category").notNull(),
  extension: text("extension").notNull(),
  fileSize: integer("file_size"),  // bytes
  mimeType: text("mime_type").notNull(),

  // Suggestions
  suggestedAction: fileActionEnum("suggested_action").notNull().default("review"),
  suggestedCategory: fileCategoryEnum("suggested_category"),

  // Conflicts/issues
  conflicts: jsonb("conflicts").$type<string[]>(),  // List of conflict descriptions

  // Additional metadata
  metadata: jsonb("metadata").$type<{
    duration?: number;  // for audio/video
    bitrate?: number;
    codec?: string;
    resolution?: string;  // for video
    [key: string]: any;
  }>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================================
// File Decisions (User decisions per file)
// ============================================================================

export const migrationFileDecisions = pgTable("migration_file_decisions", {
  id: serial("id").primaryKey(),

  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),
  catalogId: integer("catalog_id").notNull().references(() => migrationFileCatalogs.id, { onDelete: "cascade" }),

  // Decision
  action: fileActionEnum("action").notNull(),  // include, ignore, rename, review

  // If action = rename
  newFilename: text("new_filename"),

  // Target category (can override suggestion)
  targetCategory: fileCategoryEnum("target_category"),

  // Target path in new bucket
  targetS3Key: text("target_s3_key"),

  // Notes
  notes: text("notes"),

  // Audit
  decidedBy: integer("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at").defaultNow().notNull(),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// Migration Logs
// ============================================================================

export const migrationLogs = pgTable("migration_logs", {
  id: serial("id").primaryKey(),

  migrationId: integer("migration_id").notNull().references(() => migrations.id, { onDelete: "cascade" }),

  // Log details
  level: logLevelEnum("level").notNull().default("info"),
  message: text("message").notNull(),
  eventCode: text("event_code"),  // If log relates to specific event

  // Context
  context: jsonb("context").$type<Record<string, any>>(),

  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

// ============================================================================
// Media Files (Final migrated files - ALL types)
// ============================================================================

export const mediaFiles = pgTable("media_files", {
  id: serial("id").primaryKey(),

  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),

  // File type and category
  fileType: text("file_type").notNull(),  // audio, video, document, image, other
  category: fileCategoryEnum("category").notNull(),

  // File info
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  s3Bucket: text("s3_bucket").notNull().default("padmakara-pt-app"),
  fileSize: integer("file_size"),  // bytes
  mimeType: text("mime_type").notNull(),

  // Media metadata
  duration: integer("duration"),  // seconds, for audio/video
  bitrate: integer("bitrate"),    // for audio/video
  codec: text("codec"),           // for audio/video
  resolution: text("resolution"), // for video (e.g., "1920x1080")

  // Track info (for audio files that are tracks)
  sessionNumber: integer("session_number"),  // If part of a session
  trackNumber: integer("track_number"),      // If numbered track
  isTranslation: boolean("is_translation").default(false),
  isLegacy: boolean("is_legacy").default(false),

  // Transcript info (for PDF files)
  language: text("language"),  // For transcripts
  pageCount: integer("page_count"),  // For PDFs

  // Visibility
  isPublic: boolean("is_public").default(true),

  // Additional metadata
  metadata: jsonb("metadata").$type<Record<string, any>>(),

  // Migration tracking
  migratedFrom: text("migrated_from"),  // Original S3 key/path
  migrationId: integer("migration_id").references(() => migrations.id),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// Relations
// ============================================================================

export const migrationsRelations = relations(migrations, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [migrations.createdBy],
    references: [users.id],
    relationName: "migration_creator",
  }),
  approvedByUser: one(users, {
    fields: [migrations.approvedBy],
    references: [users.id],
    relationName: "migration_approver",
  }),
  fileCatalogs: many(migrationFileCatalogs),
  fileDecisions: many(migrationFileDecisions),
  logs: many(migrationLogs),
}));

export const migrationFileCatalogsRelations = relations(migrationFileCatalogs, ({ one, many }) => ({
  migration: one(migrations, {
    fields: [migrationFileCatalogs.migrationId],
    references: [migrations.id],
  }),
  decisions: many(migrationFileDecisions),
}));

export const migrationFileDecisionsRelations = relations(migrationFileDecisions, ({ one }) => ({
  migration: one(migrations, {
    fields: [migrationFileDecisions.migrationId],
    references: [migrations.id],
  }),
  catalog: one(migrationFileCatalogs, {
    fields: [migrationFileDecisions.catalogId],
    references: [migrationFileCatalogs.id],
  }),
  decidedByUser: one(users, {
    fields: [migrationFileDecisions.decidedBy],
    references: [users.id],
  }),
}));

export const migrationLogsRelations = relations(migrationLogs, ({ one }) => ({
  migration: one(migrations, {
    fields: [migrationLogs.migrationId],
    references: [migrations.id],
  }),
}));

export const mediaFilesRelations = relations(mediaFiles, ({ one }) => ({
  event: one(events, {
    fields: [mediaFiles.eventId],
    references: [events.id],
  }),
  migration: one(migrations, {
    fields: [mediaFiles.migrationId],
    references: [migrations.id],
  }),
}));
