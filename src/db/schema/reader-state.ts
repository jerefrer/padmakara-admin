import { pgTable, text, integer, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * The kinds of PDF the app's reader opens. A document is (type, id): a
 * publication's id or a transcript's id. One key for both so the reader state
 * below is one table each, not one per kind of document.
 */
export const READER_DOCUMENT_TYPES = ["publication", "transcript"] as const;
export type ReaderDocumentType = (typeof READER_DOCUMENT_TYPES)[number];

/**
 * The page each user was last on in each document, so the reader reopens it
 * there on any device. `updated_at` is when the reader was on that page (the
 * device's clock, never later than the server's): the most recent one wins
 * when a device that was offline reports an older position.
 *
 * No foreign key to the document (the id points at one of two tables): rows of
 * a deleted document are left behind and never returned, since every read
 * checks that the caller can still open the document.
 */
export const readerPositions = pgTable(
  "reader_positions",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    documentId: integer("document_id").notNull(),
    page: integer("page").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.documentType, t.documentId] }),
    check("reader_positions_document_type_check", sql`${t.documentType} IN ('publication', 'transcript')`),
    check("reader_positions_page_check", sql`${t.page} >= 1`),
  ],
);

/** Pages a user bookmarked in a document, one row per page. Same key and same orphan rule as above. */
export const readerPageBookmarks = pgTable(
  "reader_page_bookmarks",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    documentId: integer("document_id").notNull(),
    page: integer("page").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.documentType, t.documentId, t.page] }),
    check("reader_page_bookmarks_document_type_check", sql`${t.documentType} IN ('publication', 'transcript')`),
    check("reader_page_bookmarks_page_check", sql`${t.page} >= 1`),
  ],
);
