import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.ts";

export const sessionSubtitles = pgTable(
  "session_subtitles",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    language: text("language").notNull(), // ISO 639-1, e.g. "en", "pt", "es", "fr"
    label: text("label").notNull(), // human label shown in the player, e.g. "English"
    s3Key: text("s3_key").notNull(), // the .vtt source of truth
    origin: text("origin").notNull().default("transcription"), // "transcription" | "translation"
    source: text("source").notNull().default("auto"), // "auto" | "human"
    stale: boolean("stale").notNull().default(false),
    bunnyUploadedAt: timestamp("bunny_uploaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.sessionId, t.language)],
);

export const sessionSubtitlesRelations = relations(sessionSubtitles, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionSubtitles.sessionId],
    references: [sessions.id],
  }),
}));
