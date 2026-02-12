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
import { retreats } from "./retreats.ts";
import { tracks } from "./tracks.ts";

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    retreatId: integer("retreat_id")
      .notNull()
      .references(() => retreats.id, { onDelete: "cascade" }),
    titleEn: text("title_en"),
    titlePt: text("title_pt"),
    sessionDate: date("session_date", { mode: "string" }),
    timePeriod: text("time_period").default("morning"),
    sessionNumber: integer("session_number").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.retreatId, t.sessionNumber)],
);

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  retreat: one(retreats, {
    fields: [sessions.retreatId],
    references: [retreats.id],
  }),
  tracks: many(tracks),
}));
