import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";
import { users } from "./users.ts";

/**
 * One row per legacy event being re-imported from the `padmakara-pt` bucket.
 * Lifecycle status: pending → cataloged → proposed → reviewed → importing →
 * completed | failed.
 */
export const importJobs = pgTable("import_jobs", {
  id: serial("id").primaryKey(),
  eventCode: text("event_code").notNull().unique(),
  sourceBucket: text("source_bucket").notNull().default("padmakara-pt"),
  status: text("status").notNull().default("pending"),
  // AI-proposed session/track structure (Phase 2).
  proposedStructure: jsonb("proposed_structure"),
  // Human-confirmed structure used by the executor (Phase 3/4).
  confirmedStructure: jsonb("confirmed_structure"),
  // Set once the event has been imported into `retreats`.
  retreatId: integer("retreat_id").references(() => events.id, {
    onDelete: "set null",
  }),
  fileCount: integer("file_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  catalogedAt: timestamp("cataloged_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * One row per source file available for an import job. A file that lives
 * inside a ZIP has `zipEntryName` set; a loose file has it null.
 */
export const importFiles = pgTable("import_files", {
  id: serial("id").primaryKey(),
  importJobId: integer("import_job_id")
    .notNull()
    .references(() => importJobs.id, { onDelete: "cascade" }),
  // S3 key in the source bucket: the loose file, or the containing ZIP.
  sourceS3Key: text("source_s3_key").notNull(),
  // Path of the entry inside the ZIP, or null for a loose file.
  zipEntryName: text("zip_entry_name"),
  filename: text("filename").notNull(),
  extension: text("extension").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  category: text("category"),
  language: text("language"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const importJobsRelations = relations(importJobs, ({ one, many }) => ({
  retreat: one(events, {
    fields: [importJobs.retreatId],
    references: [events.id],
  }),
  files: many(importFiles),
}));

export const importFilesRelations = relations(importFiles, ({ one }) => ({
  job: one(importJobs, {
    fields: [importFiles.importJobId],
    references: [importJobs.id],
  }),
}));
