import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db as appDb, type Database } from "../db/index.ts";
import { readerPageBookmarks, readerPositions, type ReaderDocumentType } from "../db/schema/reader-state.ts";

/**
 * Per-user reader state of a PDF: the page they were last on and the pages
 * they bookmarked. Every query is scoped to one user; access to the document is
 * checked by the caller (services/reader-document-access.ts).
 *
 * The database is a parameter so the queries can be run against a throwaway
 * schema in tests; routes use the default.
 */

export interface ReaderPosition {
  page: number;
  updatedAt: Date;
}

export interface ReaderPageBookmark {
  page: number;
  createdAt: Date;
}

export interface ReaderPageBookmarkRow extends ReaderPageBookmark {
  documentType: ReaderDocumentType;
  documentId: number;
}

function documentIs(
  table: typeof readerPositions | typeof readerPageBookmarks,
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
) {
  return and(eq(table.userId, userId), eq(table.documentType, type), eq(table.documentId, documentId));
}

/** The user's last page in the document, or null if none was saved. */
export async function getReaderPosition(
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
  database: Database = appDb,
): Promise<ReaderPosition | null> {
  const [row] = await database
    .select({ page: readerPositions.page, updatedAt: readerPositions.updatedAt })
    .from(readerPositions)
    .where(documentIs(readerPositions, userId, type, documentId));
  return row ?? null;
}

/**
 * Save that the user was on `page` at `at`, unless the saved position is more
 * recent: a device coming back online must not move the reader back to where
 * they were before reading on another device. `at` is clamped to now (a device
 * clock running ahead would otherwise pin its position). Returns the position
 * now saved, which is the older device's answer to "where am I".
 */
export async function saveReaderPosition(
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
  page: number,
  at: Date,
  database: Database = appDb,
): Promise<ReaderPosition> {
  const when = new Date(Math.min(at.getTime(), Date.now()));
  await database
    .insert(readerPositions)
    .values({ userId, documentType: type, documentId, page, updatedAt: when })
    .onConflictDoUpdate({
      target: [readerPositions.userId, readerPositions.documentType, readerPositions.documentId],
      set: { page, updatedAt: when },
      setWhere: sql`${readerPositions.updatedAt} < ${when.toISOString()}::timestamptz`,
    });
  // Just written or kept as more recent: the row exists.
  return (await getReaderPosition(userId, type, documentId, database))!;
}

/** The user's bookmarked pages in the document, in page order. */
export async function listDocumentPageBookmarks(
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
  database: Database = appDb,
): Promise<ReaderPageBookmark[]> {
  return database
    .select({ page: readerPageBookmarks.page, createdAt: readerPageBookmarks.createdAt })
    .from(readerPageBookmarks)
    .where(documentIs(readerPageBookmarks, userId, type, documentId))
    .orderBy(asc(readerPageBookmarks.page));
}

/** Bookmark a page. Idempotent: a page already bookmarked keeps its first date. */
export async function addPageBookmark(
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
  page: number,
  database: Database = appDb,
): Promise<ReaderPageBookmark> {
  await database
    .insert(readerPageBookmarks)
    .values({ userId, documentType: type, documentId, page })
    .onConflictDoNothing();
  const [row] = await database
    .select({ page: readerPageBookmarks.page, createdAt: readerPageBookmarks.createdAt })
    .from(readerPageBookmarks)
    .where(and(documentIs(readerPageBookmarks, userId, type, documentId), eq(readerPageBookmarks.page, page)));
  // Just inserted or already there.
  return row!;
}

/** Remove a page bookmark. Idempotent: removing one that is not there is not an error. */
export async function removePageBookmark(
  userId: number,
  type: ReaderDocumentType,
  documentId: number,
  page: number,
  database: Database = appDb,
): Promise<void> {
  await database
    .delete(readerPageBookmarks)
    .where(and(documentIs(readerPageBookmarks, userId, type, documentId), eq(readerPageBookmarks.page, page)));
}

/** Every page bookmark of the user, newest first. */
export async function listUserPageBookmarks(
  userId: number,
  database: Database = appDb,
): Promise<ReaderPageBookmarkRow[]> {
  const rows = await database
    .select({
      documentType: readerPageBookmarks.documentType,
      documentId: readerPageBookmarks.documentId,
      page: readerPageBookmarks.page,
      createdAt: readerPageBookmarks.createdAt,
    })
    .from(readerPageBookmarks)
    .where(eq(readerPageBookmarks.userId, userId))
    .orderBy(desc(readerPageBookmarks.createdAt), asc(readerPageBookmarks.page));
  // The column is CHECK-constrained to the two types.
  return rows as ReaderPageBookmarkRow[];
}
