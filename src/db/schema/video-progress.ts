import {
  pgTable,
  serial,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { sessions } from "./sessions.ts";

/**
 * Cross-device watched-position storage for session videos.
 *
 * Audio playback uses the (older) `user_progress` table keyed by track_id;
 * video playback is keyed by session_id (a session has at most one video,
 * tracks live below it). Rather than overload `user_progress` with a
 * nullable session_id, we keep the schemas disjoint.
 *
 * One row per (user, session). Last-write-wins by `updated_at` — with a
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
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.userId, t.sessionId)],
);

export const videoProgressRelations = relations(videoProgress, ({ one }) => ({
  user: one(users, {
    fields: [videoProgress.userId],
    references: [users.id],
  }),
  session: one(sessions, {
    fields: [videoProgress.sessionId],
    references: [sessions.id],
  }),
}));
