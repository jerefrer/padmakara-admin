import { pgTable, varchar, integer, timestamp } from "drizzle-orm/pg-core";

export const syncVersions = pgTable("sync_versions", {
  namespace: varchar("namespace", { length: 64 }).primaryKey(),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SyncVersion = typeof syncVersions.$inferSelect;
