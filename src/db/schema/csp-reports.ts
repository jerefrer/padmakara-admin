import { pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Content-Security-Policy violation reports sent by browsers, reduced to what
 * is needed to judge a policy and nothing that could identify a person: no IP,
 * no full URL (presigned storage URLs and tokens live in query strings), no raw
 * user agent. One row per unique (site, directive, blocked, source) with a
 * counter, so a noisy page cannot fill the table.
 *
 * `source` is "" when the browser gave no source file (the column takes part in
 * the unique index, and NULLs would never collide).
 */
export const cspReports = pgTable(
  "csp_reports",
  {
    id: serial("id").primaryKey(),
    /** "app", "admin" or "other", from the origin of the reported document. */
    site: text("site").notNull(),
    /** Effective directive, e.g. "script-src-elem". */
    directive: text("directive").notNull(),
    /** Blocked URI reduced to scheme+host, or a keyword (inline, eval, data, blob...). */
    blocked: text("blocked").notNull(),
    /** Source file reduced to origin+path, no query string; "" when absent. */
    source: text("source").notNull().default(""),
    /** Position of the latest occurrence, when the browser reported one. */
    lineNumber: integer("line_number"),
    columnNumber: integer("column_number"),
    /** "report" or "enforce", from the latest occurrence. */
    disposition: text("disposition").notNull().default("report"),
    /** Coarse browser family and major version of the latest occurrence, e.g. "Safari 18". */
    browser: text("browser").notNull().default("unknown"),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("csp_reports_unique_idx").on(t.site, t.directive, t.blocked, t.source),
  ],
);

export type CspReport = typeof cspReports.$inferSelect;
