import {
  pgTable,
  serial,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { eventVideos } from "./event-videos.ts";

/**
 * Cross-device watched-position storage for event videos.
 *
 * Audio playback uses the (older) `user_progress` table keyed by track_id;
 * video playback is keyed by the event_videos row. Rather than overload
 * `user_progress` with a nullable video_id, we keep the schemas disjoint.
 *
 * One row per (user, video). Last-write-wins by `updated_at` — with a
 * 5-second client-side throttle, two devices playing the same video
 * simultaneously could clobber each other, but the worst case is ±5s of
 * resume position which is acceptable.
 */
export const videoProgress = pgTable(
  "video_progress",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => eventVideos.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.userId, t.videoId)],
);

export const videoProgressRelations = relations(videoProgress, ({ one }) => ({
  user: one(users, {
    fields: [videoProgress.userId],
    references: [users.id],
  }),
  video: one(eventVideos, {
    fields: [videoProgress.videoId],
    references: [eventVideos.id],
  }),
}));
