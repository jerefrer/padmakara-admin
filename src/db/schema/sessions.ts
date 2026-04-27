import {
  pgTable,
  serial,
  text,
  date,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";
import { tracks } from "./tracks.ts";

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    titleEn: text("title_en"),
    titlePt: text("title_pt"),
    sessionDate: date("session_date", { mode: "string" }),
    timePeriod: text("time_period").default("morning"),
    sessionNumber: integer("session_number").notNull(),
    partNumber: integer("part_number"),
    description: text("description"),
    // Optional video recording for this session. Audio tracks (above) remain
    // the canonical topic-indexed content; the session video is the unedited
    // full recording, viewed via Bunny Stream.
    bunnyVideoId: text("bunny_video_id"),
    videoDurationSeconds: integer("video_duration_seconds"),
    videoPosterUrl: text("video_poster_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.eventId, t.sessionNumber)],
);

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  event: one(events, {
    fields: [sessions.eventId],
    references: [events.id],
  }),
  tracks: many(tracks),
}));
