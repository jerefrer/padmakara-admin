import { pgTable, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

export const userSyncVersions = pgTable(
  "user_sync_versions",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId] }),
  }),
);

export type UserSyncVersion = typeof userSyncVersions.$inferSelect;
