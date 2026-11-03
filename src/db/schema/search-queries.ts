import { pgTable, serial, text, integer, varchar, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Anonymous log of final searches. Deliberately has NO user id, device id or
 * any other column that could link a search to a person (religious beliefs
 * are a GDPR special category). Rows are purged after 24 months.
 */
export const searchQueries = pgTable(
  "search_queries",
  {
    id: serial("id").primaryKey(),
    query: text("query").notNull(),
    resultCount: integer("result_count").notNull(),
    language: varchar("language", { length: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("search_queries_created_at_idx").on(t.createdAt)],
);

export type SearchQuery = typeof searchQueries.$inferSelect;
