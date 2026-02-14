import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";

export const transcripts = pgTable("transcripts", {
  id: serial("id").primaryKey(),
  eventId: integer("retreat_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
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
  event: one(events, {
    fields: [transcripts.eventId],
    references: [events.id],
  }),
}));
