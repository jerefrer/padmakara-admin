import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  smallint,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";

export const readAlongJobs = pgTable("read_along_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),

  // Status tracking: pending → submitted → processing → completed | failed
  status: text("status").notNull().default("pending"),

  // AWS Batch job ID (set after SubmitJob)
  batchJobId: text("batch_job_id"),

  // Processing parameters
  language: text("language").notNull().default("en"),
  skipPages: smallint("skip_pages").notNull().default(7),
  whisperModel: text("whisper_model").notNull().default("turbo"),

  // Results (set by webhook on completion)
  uploadedFiles: jsonb("uploaded_files"), // { mp3Name: s3Key, ... }
  summary: jsonb("summary"), // alignment_summary.json contents

  // Error handling
  errorMessage: text("error_message"),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const readAlongJobsRelations = relations(readAlongJobs, ({ one }) => ({
  event: one(events, {
    fields: [readAlongJobs.eventId],
    references: [events.id],
  }),
}));
