import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  uuid,
  smallint,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { events } from "./retreats.ts";

export const downloadRequests = pgTable("download_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),

  // Status tracking (matches Django STATUS_CHOICES)
  status: text("status").notNull().default("pending"), // pending|processing|ready|failed|expired

  // File information
  fileSize: bigint("file_size", { mode: "number" }),
  downloadUrl: text("download_url"),
  s3Key: text("s3_key"),

  // Error handling
  errorMessage: text("error_message"),
  retryCount: smallint("retry_count").notNull().default(0),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),

  // Progress tracking
  totalFiles: integer("total_files"),
  processedFiles: integer("processed_files").notNull().default(0),
  progressPercent: smallint("progress_percent").notNull().default(0),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  processingCompletedAt: timestamp("processing_completed_at", { withTimezone: true }),
});

export const downloadRequestsRelations = relations(downloadRequests, ({ one }) => ({
  user: one(users, {
    fields: [downloadRequests.userId],
    references: [users.id],
  }),
  event: one(events, {
    fields: [downloadRequests.eventId],
    references: [events.id],
  }),
}));
