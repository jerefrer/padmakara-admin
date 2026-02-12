import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { retreats } from "./retreats.ts";
import { sessions } from "./sessions.ts";

export const transcripts = pgTable("transcripts", {
  id: serial("id").primaryKey(),
  retreatId: integer("retreat_id")
    .notNull()
    .references(() => retreats.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  language: text("language").notNull(),
  s3Key: text("s3_key"),
  pageCount: integer("page_count"),
  status: text("status").notNull().default("draft"),
  originalFilename: text("original_filename"),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const transcriptsRelations = relations(transcripts, ({ one }) => ({
  retreat: one(retreats, {
    fields: [transcripts.retreatId],
    references: [retreats.id],
  }),
  session: one(sessions, {
    fields: [transcripts.sessionId],
    references: [sessions.id],
  }),
}));
