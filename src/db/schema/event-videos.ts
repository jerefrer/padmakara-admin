import { pgTable, serial, text, integer, date, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";

export const eventVideos = pgTable(
  "event_videos",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    // Bunny Stream video GUID. One recording file = one row.
    bunnyVideoId: text("bunny_video_id").notNull(),
    // Playback order within the event (0-based).
    position: integer("position").notNull().default(0),
    // Optional human labels. Null → clients derive a fallback from
    // videoDate / position ("Part N").
    titleEn: text("title_en"),
    titlePt: text("title_pt"),
    // Optional recording date — labeling/ordering hint only. A video may
    // cover any slice of the event (one session, a morning, a full day).
    videoDate: date("video_date", { mode: "string" }),
    durationSeconds: integer("duration_seconds"),
    posterUrl: text("poster_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("event_videos_event_id_idx").on(t.eventId),
    // Webhook + playback look videos up by their Bunny GUID.
    index("event_videos_bunny_video_id_idx").on(t.bunnyVideoId),
  ],
);

export const eventVideosRelations = relations(eventVideos, ({ one }) => ({
  event: one(events, {
    fields: [eventVideos.eventId],
    references: [events.id],
  }),
}));
