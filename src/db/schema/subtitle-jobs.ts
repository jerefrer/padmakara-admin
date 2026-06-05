import { pgTable, uuid, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.ts";

export const subtitleJobs = pgTable("subtitle_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  batchJobId: text("batch_job_id"),
  language: text("language").notNull().default("en"),
  whisperModel: text("whisper_model").notNull().default("turbo"),
  model: text("model"), // LLM used for translation jobs (null for source/transcription jobs)
  summary: jsonb("summary"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const subtitleJobsRelations = relations(subtitleJobs, ({ one }) => ({
  session: one(sessions, {
    fields: [subtitleJobs.sessionId],
    references: [sessions.id],
  }),
}));
