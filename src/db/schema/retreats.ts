import {
  pgTable,
  serial,
  text,
  date,
  timestamp,
  integer,
  primaryKey,
  boolean,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teachers } from "./teachers.ts";
import { places } from "./places.ts";
import { retreatGroups } from "./retreat-groups.ts";
import { sessions } from "./sessions.ts";
import { eventTypes } from "./event-types.ts";
import { audiences } from "./audiences.ts";
import { transcripts } from "./transcripts.ts";
import { eventFiles } from "./event-files.ts";
import { eventPublications } from "./publications.ts";
import { eventVideos } from "./event-videos.ts";

export const events = pgTable("retreats", {
  id: serial("id").primaryKey(),
  eventCode: text("event_code").notNull().unique(),
  titleEn: text("title_en").notNull(),
  titlePt: text("title_pt"),
  mainThemesPt: text("main_themes_pt"),
  mainThemesEn: text("main_themes_en"),
  sessionThemesEn: text("session_themes_en"),
  sessionThemesPt: text("session_themes_pt"),
  titleEnReviewed: boolean("title_en_reviewed").notNull().default(true),
  titlePtReviewed: boolean("title_pt_reviewed").notNull().default(true),
  mainThemesEnReviewed: boolean("main_themes_en_reviewed").notNull().default(true),
  mainThemesPtReviewed: boolean("main_themes_pt_reviewed").notNull().default(true),
  sessionThemesEnReviewed: boolean("session_themes_en_reviewed").notNull().default(true),
  sessionThemesPtReviewed: boolean("session_themes_pt_reviewed").notNull().default(true),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  eventTypeId: integer("event_type_id").references(() => eventTypes.id, {
    onDelete: "set null",
  }),
  audienceId: integer("audience_id").references(() => audiences.id, {
    onDelete: "set null",
  }),
  bibliography: text("bibliography"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  imageUrl: text("image_url"),
  s3Prefix: text("s3_prefix"),
  wixId: text("wix_id"),
  featuredAt: timestamp("featured_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Junction: event <-> teacher
export const eventTeachers = pgTable(
  "retreat_teachers",
  {
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    teacherId: integer("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("teacher"),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.teacherId, t.role] })],
);

// Junction: event <-> retreat group
export const eventRetreatGroups = pgTable(
  "retreat_group_retreats",
  {
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    retreatGroupId: integer("retreat_group_id")
      .notNull()
      .references(() => retreatGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.retreatGroupId] })],
);

// Junction: event <-> place
export const eventPlaces = pgTable(
  "retreat_places",
  {
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    placeId: integer("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.placeId] })],
);

// Relations
export const eventsRelations = relations(events, ({ one, many }) => ({
  eventType: one(eventTypes, {
    fields: [events.eventTypeId],
    references: [eventTypes.id],
  }),
  audience: one(audiences, {
    fields: [events.audienceId],
    references: [audiences.id],
  }),
  sessions: many(sessions),
  videos: many(eventVideos),
  transcripts: many(transcripts),
  eventFiles: many(eventFiles),
  eventTeachers: many(eventTeachers),
  eventRetreatGroups: many(eventRetreatGroups),
  eventPlaces: many(eventPlaces),
  eventPublications: many(eventPublications),
}));

export const eventTeachersRelations = relations(eventTeachers, ({ one }) => ({
  event: one(events, {
    fields: [eventTeachers.eventId],
    references: [events.id],
  }),
  teacher: one(teachers, {
    fields: [eventTeachers.teacherId],
    references: [teachers.id],
  }),
}));

export const eventRetreatGroupsRelations = relations(eventRetreatGroups, ({ one }) => ({
  event: one(events, {
    fields: [eventRetreatGroups.eventId],
    references: [events.id],
  }),
  retreatGroup: one(retreatGroups, {
    fields: [eventRetreatGroups.retreatGroupId],
    references: [retreatGroups.id],
  }),
}));

export const eventPlacesRelations = relations(eventPlaces, ({ one }) => ({
  event: one(events, {
    fields: [eventPlaces.eventId],
    references: [events.id],
  }),
  place: one(places, {
    fields: [eventPlaces.placeId],
    references: [places.id],
  }),
}));
