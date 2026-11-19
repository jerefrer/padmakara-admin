import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { READER_DOCUMENT_TYPES, type ReaderDocumentType } from "../db/schema/reader-state.ts";
import {
  canOpenReaderDocument,
  openableReaderDocuments,
  readerDocumentKey,
} from "../services/reader-document-access.ts";
import {
  addPageBookmark,
  getReaderPosition,
  listDocumentPageBookmarks,
  listUserPageBookmarks,
  removePageBookmark,
  saveReaderPosition,
  type ReaderPosition,
} from "../services/reader-state.ts";

/**
 * Reader state of a PDF (publication or transcript) for the signed-in caller:
 * the page they were last on, so it reopens there on any device, and the pages
 * they bookmarked. A document is `/:type/:id`, type `publication` or
 * `transcript`.
 *
 * Every route acts on the caller's own rows only, and only for a document they
 * can open now (services/reader-document-access.ts): any other document is a
 * 404, whatever the reason, and nothing is stored.
 */
export const readerRoutes = new Hono();

readerRoutes.use("*", authMiddleware);

/** No PDF the app serves comes near this; it only bounds what a client can store. */
const MAX_PAGE = 100_000;

const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE);

const positionSchema = z.object({
  page: z.number().int().min(1).max(MAX_PAGE),
  /** When the reader was on that page (the device's clock). Defaults to now. */
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

function documentParams(type: string | undefined, rawId: string | undefined): { type: ReaderDocumentType; id: number } {
  if (!type || !(READER_DOCUMENT_TYPES as readonly string[]).includes(type)) {
    throw AppError.badRequest("Invalid document type");
  }
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) throw AppError.badRequest("Invalid document ID");
  return { type: type as ReaderDocumentType, id };
}

function parsePage(raw: string | undefined): number {
  const result = pageSchema.safeParse(raw);
  if (!result.success) throw AppError.badRequest("Invalid page");
  return result.data;
}

async function assertCanOpen(caller: { id: number; role: string }, doc: { type: ReaderDocumentType; id: number }) {
  if (!(await canOpenReaderDocument(caller, doc))) throw AppError.notFound("Document not found");
}

function positionJson(position: ReaderPosition | null) {
  return position ? { page: position.page, updatedAt: position.updatedAt.toISOString() } : null;
}

/**
 * GET /api/reader/bookmarks — Every page the caller bookmarked, newest first,
 * with what the app needs to list and open them: the publication's title, or
 * the transcript's language and event. Bookmarks in a document the caller can
 * no longer open stay saved but are not listed.
 */
readerRoutes.get("/bookmarks", async (c) => {
  const user = getUser(c);
  const rows = await listUserPageBookmarks(user.id);
  const documents = await openableReaderDocuments(
    user,
    rows.map((r) => ({ type: r.documentType, id: r.documentId })),
  );
  const bookmarks = rows.flatMap((row) => {
    const document = documents.get(readerDocumentKey(row.documentType, row.documentId));
    if (!document) return [];
    return [
      {
        documentType: row.documentType,
        documentId: row.documentId,
        page: row.page,
        createdAt: row.createdAt.toISOString(),
        document,
      },
    ];
  });
  return c.json({ bookmarks });
});

/**
 * GET /api/reader/:type/:id — The caller's state in one document:
 * `{ position: { page, updatedAt } | null, bookmarks: [{ page, createdAt }] }`,
 * bookmarks in page order.
 */
readerRoutes.get("/:type/:id", async (c) => {
  const user = getUser(c);
  const doc = documentParams(c.req.param("type"), c.req.param("id"));
  await assertCanOpen(user, doc);
  const [position, bookmarks] = await Promise.all([
    getReaderPosition(user.id, doc.type, doc.id),
    listDocumentPageBookmarks(user.id, doc.type, doc.id),
  ]);
  return c.json({
    position: positionJson(position),
    bookmarks: bookmarks.map((b) => ({ page: b.page, createdAt: b.createdAt.toISOString() })),
  });
});

/**
 * PUT /api/reader/:type/:id/position — `{ page, updatedAt? }`: the caller was on
 * `page` at `updatedAt` (default now). Kept only if more recent than the saved
 * position; answers `{ position }` with the one now saved either way.
 */
readerRoutes.put("/:type/:id/position", async (c) => {
  const user = getUser(c);
  const doc = documentParams(c.req.param("type"), c.req.param("id"));
  const body = positionSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw AppError.badRequest("Invalid position", "VALIDATION_ERROR");
  await assertCanOpen(user, doc);
  const at = body.data.updatedAt ? new Date(body.data.updatedAt) : new Date();
  const position = await saveReaderPosition(user.id, doc.type, doc.id, body.data.page, at);
  return c.json({ position: positionJson(position) });
});

/** PUT /api/reader/:type/:id/bookmarks/:page — Bookmark a page (idempotent). Answers `{ bookmark: { page, createdAt } }`. */
readerRoutes.put("/:type/:id/bookmarks/:page", async (c) => {
  const user = getUser(c);
  const doc = documentParams(c.req.param("type"), c.req.param("id"));
  const page = parsePage(c.req.param("page"));
  await assertCanOpen(user, doc);
  const bookmark = await addPageBookmark(user.id, doc.type, doc.id, page);
  return c.json({ bookmark: { page: bookmark.page, createdAt: bookmark.createdAt.toISOString() } });
});

/** DELETE /api/reader/:type/:id/bookmarks/:page — Remove a page bookmark (idempotent, 204). */
readerRoutes.delete("/:type/:id/bookmarks/:page", async (c) => {
  const user = getUser(c);
  const doc = documentParams(c.req.param("type"), c.req.param("id"));
  const page = parsePage(c.req.param("page"));
  await assertCanOpen(user, doc);
  await removePageBookmark(user.id, doc.type, doc.id, page);
  return c.body(null, 204);
});
