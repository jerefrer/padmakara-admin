import { pgTable, date, text, integer, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/**
 * Server-side usage totals: one counter per (day, metric, event). No user
 * column on purpose: these rows are aggregates and can never be traced to a
 * person. event_id 0 means "not tied to an event" (no foreign key, so a
 * deleted event keeps its history).
 */
export const usageDaily = pgTable(
  "usage_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    metric: text("metric").notNull(),
    eventId: integer("event_id").notNull().default(0),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric, t.eventId] })],
);

/**
 * Which days an account was active. The only per-user usage data we keep:
 * used for distinct-user totals only, deleted after 13 months.
 */
export const userActiveDays = pgTable(
  "user_active_days",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] }), index("user_active_days_day_idx").on(t.day)],
);
