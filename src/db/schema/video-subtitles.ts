import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { eventVideos } from "./event-videos.ts";

export const videoSubtitles = pgTable(
  "video_subtitles",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => eventVideos.id, { onDelete: "cascade" }),
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
  (t) => [unique().on(t.videoId, t.language)],
);

export const videoSubtitlesRelations = relations(videoSubtitles, ({ one }) => ({
  video: one(eventVideos, {
    fields: [videoSubtitles.videoId],
    references: [eventVideos.id],
  }),
}));
