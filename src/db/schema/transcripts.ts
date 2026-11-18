import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { events } from "./retreats.ts";

/**
 * Revision state of a transcript PDF. Descriptive only: it is shown to readers
 * as a tag and never decides visibility (`published` does), because a
 * provisional or unrevised text is sometimes shared on purpose.
 */
export const TRANSCRIPT_STATUSES = ["final", "provisional", "unrevised", "draft"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** Language codes a transcript can carry (same codes as tracks). */
export const TRANSCRIPT_LANGUAGES = ["en", "pt", "fr", "tib"] as const;

export const transcripts = pgTable(
  "transcripts",
  {
    id: serial("id").primaryKey(),
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    // Not constrained in the database: the legacy seed (scripts/csv-parser.ts
    // mapLanguage) can write "unknown". The API validates TRANSCRIPT_LANGUAGES.
    language: text("language").notNull(),
    s3Key: text("s3_key"),
    pageCount: integer("page_count"),
    status: text("status").notNull().default("final"),
    /** The file holds excerpts, not the full teaching. Orthogonal to the status. */
    isExcerpt: boolean("is_excerpt").notNull().default(false),
    /**
     * Whether non-admins see the file. A new upload starts unpublished so an
     * admin reviews it first; rows that existed before the column stayed on.
     */
    published: boolean("published").notNull().default(false),
    originalFilename: text("original_filename"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "transcripts_status_check",
      sql`${t.status} IN ('final', 'provisional', 'unrevised', 'draft')`,
    ),
  ],
);

export const transcriptsRelations = relations(transcripts, ({ one }) => ({
  event: one(events, {
    fields: [transcripts.eventId],
    references: [events.id],
  }),
}));
