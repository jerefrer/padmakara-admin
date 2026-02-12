import {
  pgTable,
  serial,
  text,
  date,
  timestamp,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { teachers } from "./teachers.ts";
import { places } from "./places.ts";
import { retreatGroups } from "./retreat-groups.ts";
import { sessions } from "./sessions.ts";

export const retreats = pgTable("retreats", {
  id: serial("id").primaryKey(),
  eventCode: text("event_code").notNull().unique(),
  titleEn: text("title_en").notNull(),
  titlePt: text("title_pt"),
  descriptionEn: text("description_en"),
  descriptionPt: text("description_pt"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  designation: text("designation"),
  audience: text("audience").default("members"),
  bibliography: text("bibliography"),
  sessionThemes: text("session_themes"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  imageUrl: text("image_url"),
  s3Prefix: text("s3_prefix"),
  wixId: text("wix_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Junction: retreat <-> teacher
export const retreatTeachers = pgTable(
  "retreat_teachers",
  {
    retreatId: integer("retreat_id")
      .notNull()
      .references(() => retreats.id, { onDelete: "cascade" }),
    teacherId: integer("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("teacher"),
  },
  (t) => [primaryKey({ columns: [t.retreatId, t.teacherId, t.role] })],
);

// Junction: retreat <-> retreat group
export const retreatGroupRetreats = pgTable(
  "retreat_group_retreats",
  {
    retreatId: integer("retreat_id")
      .notNull()
      .references(() => retreats.id, { onDelete: "cascade" }),
    retreatGroupId: integer("retreat_group_id")
      .notNull()
      .references(() => retreatGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.retreatId, t.retreatGroupId] })],
);

// Junction: retreat <-> place
export const retreatPlaces = pgTable(
  "retreat_places",
  {
    retreatId: integer("retreat_id")
      .notNull()
      .references(() => retreats.id, { onDelete: "cascade" }),
    placeId: integer("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.retreatId, t.placeId] })],
);

// Relations
export const retreatsRelations = relations(retreats, ({ many }) => ({
  sessions: many(sessions),
  retreatTeachers: many(retreatTeachers),
  retreatGroups: many(retreatGroupRetreats),
  retreatPlaces: many(retreatPlaces),
}));

export const retreatTeachersRelations = relations(retreatTeachers, ({ one }) => ({
  retreat: one(retreats, {
    fields: [retreatTeachers.retreatId],
    references: [retreats.id],
  }),
  teacher: one(teachers, {
    fields: [retreatTeachers.teacherId],
    references: [teachers.id],
  }),
}));

export const retreatGroupRetreatsRelations = relations(retreatGroupRetreats, ({ one }) => ({
  retreat: one(retreats, {
    fields: [retreatGroupRetreats.retreatId],
    references: [retreats.id],
  }),
  retreatGroup: one(retreatGroups, {
    fields: [retreatGroupRetreats.retreatGroupId],
    references: [retreatGroups.id],
  }),
}));

export const retreatPlacesRelations = relations(retreatPlaces, ({ one }) => ({
  retreat: one(retreats, {
    fields: [retreatPlaces.retreatId],
    references: [retreats.id],
  }),
  place: one(places, {
    fields: [retreatPlaces.placeId],
    references: [places.id],
  }),
}));
