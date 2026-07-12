import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sessions } from "./sessions.ts";

export const sessionVideos = pgTable(
  "session_videos",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // Bunny Stream video GUID. One recording file = one row.
    bunnyVideoId: text("bunny_video_id").notNull(),
    // Playback order within the session (0-based).
    position: integer("position").notNull().default(0),
    // Optional human label, e.g. "Part 1". Null → derive "Part N" from position.
    title: text("title"),
    durationSeconds: integer("duration_seconds"),
    posterUrl: text("poster_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("session_videos_session_id_idx").on(t.sessionId),
    // Webhook + playback look videos up by their Bunny GUID.
    index("session_videos_bunny_video_id_idx").on(t.bunnyVideoId),
  ],
);

export const sessionVideosRelations = relations(sessionVideos, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionVideos.sessionId],
    references: [sessions.id],
  }),
}));
