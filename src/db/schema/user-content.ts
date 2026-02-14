import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  real,
  timestamp,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";
import { tracks } from "./tracks.ts";
import { events } from "./retreats.ts";

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

export const userNotes = pgTable("user_notes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  eventId: integer("retreat_id").references(() => events.id, {
    onDelete: "set null",
  }),
  trackId: integer("track_id").references(() => tracks.id, {
    onDelete: "set null",
  }),
  title: text("title"),
  content: text("content").notNull(),
  tags: jsonb("tags").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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

export const userNotesRelations = relations(userNotes, ({ one }) => ({
  user: one(users, {
    fields: [userNotes.userId],
    references: [users.id],
  }),
  event: one(events, {
    fields: [userNotes.eventId],
    references: [events.id],
  }),
  track: one(tracks, {
    fields: [userNotes.trackId],
    references: [tracks.id],
  }),
}));
