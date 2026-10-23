import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  real,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { tracks } from "./tracks.ts";
import { events } from "./retreats.ts";
import { eventVideos } from "./event-videos.ts";

export const userProgress = pgTable(
  "user_progress",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    completionPct: real("completion_pct").notNull().default(0),
    isCompleted: boolean("is_completed").notNull().default(false),
    playCount: integer("play_count").notNull().default(0),
    totalListenSeconds: integer("total_listen_seconds").notNull().default(0),
    lastPlayed: timestamp("last_played", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.userId, t.trackId)],
);

export const bookmarks = pgTable("bookmarks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  trackId: integer("track_id")
    .notNull()
    .references(() => tracks.id, { onDelete: "cascade" }),
  positionSeconds: integer("position_seconds").notNull(),
  title: text("title"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const eventBookmarks = pgTable(
  "event_bookmarks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.userId, t.eventId),
    index("event_bookmarks_user_id_idx").on(t.userId),
  ],
);

// Whole-track bookmarks (no time position). Coexists with the older
// position-based `bookmarks` table; this one is what the player toolbar
// toggles, and it lists alongside event bookmarks on the Bookmarks tab.
export const trackBookmarks = pgTable(
  "track_bookmarks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trackId: integer("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.userId, t.trackId),
    index("track_bookmarks_user_id_idx").on(t.userId),
  ],
);

// Position bookmarks inside an event video. Unlike track_bookmarks there is
// no unique (user, video): several moments in one video are allowed.
export const videoBookmarks = pgTable(
  "video_bookmarks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => eventVideos.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("video_bookmarks_user_id_idx").on(t.userId)],
);

// Relations
export const userProgressRelations = relations(userProgress, ({ one }) => ({
  user: one(users, {
    fields: [userProgress.userId],
    references: [users.id],
  }),
  track: one(tracks, {
    fields: [userProgress.trackId],
    references: [tracks.id],
  }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),
  track: one(tracks, {
    fields: [bookmarks.trackId],
    references: [tracks.id],
  }),
}));

export const eventBookmarksRelations = relations(eventBookmarks, ({ one }) => ({
  user: one(users, {
    fields: [eventBookmarks.userId],
    references: [users.id],
  }),
  event: one(events, {
    fields: [eventBookmarks.eventId],
    references: [events.id],
  }),
}));

export const trackBookmarksRelations = relations(trackBookmarks, ({ one }) => ({
  user: one(users, {
    fields: [trackBookmarks.userId],
    references: [users.id],
  }),
  track: one(tracks, {
    fields: [trackBookmarks.trackId],
    references: [tracks.id],
  }),
}));


export const videoBookmarksRelations = relations(videoBookmarks, ({ one }) => ({
  user: one(users, {
    fields: [videoBookmarks.userId],
    references: [users.id],
  }),
  video: one(eventVideos, {
    fields: [videoBookmarks.videoId],
    references: [eventVideos.id],
  }),
}));
