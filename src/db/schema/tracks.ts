import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  bigint,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.ts";

export const tracks = pgTable(
  "tracks",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    trackNumber: integer("track_number").notNull(),
    language: text("language").notNull().default("en"),
    isTranslation: boolean("is_translation").notNull().default(false),
    originalTrackId: integer("original_track_id").references((): any => tracks.id, {
      onDelete: "set null",
    }),
    s3Key: text("s3_key"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    originalFilename: text("original_filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.sessionId, t.trackNumber, t.language)],
);

export const tracksRelations = relations(tracks, ({ one }) => ({
  session: one(sessions, {
    fields: [tracks.sessionId],
    references: [sessions.id],
  }),
  originalTrack: one(tracks, {
    fields: [tracks.originalTrackId],
    references: [tracks.id],
  }),
}));
