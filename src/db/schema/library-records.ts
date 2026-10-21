import { pgTable, text, date, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * The association's library metadata (Wix "libraryEvent" CSV export), one row
 * per Wix event. Replaced wholesale on every upload; events link to a record
 * through `retreats.wix_id`.
 */
export const libraryRecords = pgTable(
  "library_records",
  {
    wixId: text("wix_id").primaryKey(),
    eventCode: text("event_code"),
    title: text("title").notNull().default(""),
    teacherNames: text("teacher_names").notNull().default(""),
    guestName: text("guest_name").notNull().default(""),
    organization: text("organization").notNull().default(""),
    place: text("place").notNull().default(""),
    designation: text("designation").notNull().default(""),
    dateRange: text("date_range").notNull().default(""),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("library_records_event_code_idx").on(t.eventCode),
    index("library_records_start_date_idx").on(t.startDate),
  ],
);
