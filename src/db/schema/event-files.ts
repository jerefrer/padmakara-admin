import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";
import { sessions } from "./sessions.ts";

/**
 * Event files table - stores non-media files (images, subtitles, docs, etc.)
 * that don't fit into tracks (audio/video) or transcripts (PDFs) tables.
 */
export const eventFiles = pgTable("event_files", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),

  // File metadata
  originalFilename: text("original_filename").notNull(),
  s3Key: text("s3_key").notNull(),
  fileType: text("file_type").notNull(), // image, subtitle, document, design, other
  extension: text("extension").notNull(), // .jpg, .vtt, .doc, etc.
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  language: text("language"), // Optional language for subtitles, docs, etc.

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const eventFilesRelations = relations(eventFiles, ({ one }) => ({
  event: one(events, {
    fields: [eventFiles.eventId],
    references: [events.id],
  }),
  session: one(sessions, {
    fields: [eventFiles.sessionId],
    references: [sessions.id],
  }),
}));
