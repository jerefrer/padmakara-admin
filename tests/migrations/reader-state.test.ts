import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schemaTables from "../../src/db/schema/index.ts";
import type { Database } from "../../src/db/index.ts";
import {
  addPageBookmark,
  getReaderPosition,
  listDocumentPageBookmarks,
  listUserPageBookmarks,
  removePageBookmark,
  saveReaderPosition,
} from "../../src/services/reader-state.ts";

// Runs 0080_reader_state.sql in a throwaway schema of the test database, on a
// minimal copy of users, then runs the service queries against it. Skipped
// when no database is reachable.

const url = process.env.DATABASE_URL!;
const schema = `mig0080_${process.pid}`;
const migration = readFileSync(
  path.join(import.meta.dirname, "../../src/db/migrations/0080_reader_state.sql"),
  "utf8",
).replaceAll(`"public".`, `"${schema}".`);

const sql = postgres(url, {
  max: 1,
  connect_timeout: 2,
  onnotice: () => {},
  connection: { search_path: schema },
});
// Same table objects as the app; unqualified names resolve to the throwaway schema.
const testDb = drizzle(sql, { schema: schemaTables }) as unknown as Database;
let reachable = true;

async function count(table: string): Promise<number> {
  const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
  return row!.n;
}

const HOUR = 3_600_000;

describe("0080_reader_state.sql", () => {
  beforeAll(async () => {
    try {
      await sql`SELECT 1`;
    } catch {
      reachable = false;
    }
  });

  beforeEach(async () => {
    if (!reachable) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`CREATE TABLE ${schema}.users (id serial PRIMARY KEY)`);
    await sql.unsafe(`INSERT INTO ${schema}.users DEFAULT VALUES; INSERT INTO ${schema}.users DEFAULT VALUES`);
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    if (reachable) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  });

  it("should apply twice without error", async (ctx) => {
    if (!reachable) return ctx.skip();

    await sql.unsafe(migration);

    expect(await count("reader_positions")).toBe(0);
    expect(await count("reader_page_bookmarks")).toBe(0);
  });

  describe("positions", () => {
    it("should return null when no page was saved", async (ctx) => {
      if (!reachable) return ctx.skip();

      expect(await getReaderPosition(1, "publication", 7, testDb)).toBeNull();
    });

    it("should keep one row per user and document, moved to the latest page", async (ctx) => {
      if (!reachable) return ctx.skip();
      await saveReaderPosition(1, "publication", 7, 3, new Date(Date.now() - 2 * HOUR), testDb);

      const saved = await saveReaderPosition(1, "publication", 7, 12, new Date(Date.now() - HOUR), testDb);

      expect(saved.page).toBe(12);
      expect(await count("reader_positions")).toBe(1);
    });

    it("should keep the saved page when an older position arrives late", async (ctx) => {
      if (!reachable) return ctx.skip();
      await saveReaderPosition(1, "publication", 7, 40, new Date(Date.now() - HOUR), testDb);

      const saved = await saveReaderPosition(1, "publication", 7, 5, new Date(Date.now() - 2 * HOUR), testDb);

      expect(saved.page).toBe(40);
      expect((await getReaderPosition(1, "publication", 7, testDb))?.page).toBe(40);
    });

    it("should not let a clock running ahead pin a page in the future", async (ctx) => {
      if (!reachable) return ctx.skip();
      await saveReaderPosition(1, "transcript", 2, 9, new Date(Date.now() + 24 * HOUR), testDb);

      const saved = await saveReaderPosition(1, "transcript", 2, 10, new Date(), testDb);

      expect(saved.page).toBe(10);
    });

    it("should keep a publication and a transcript with the same id apart", async (ctx) => {
      if (!reachable) return ctx.skip();
      await saveReaderPosition(1, "publication", 5, 3, new Date(), testDb);
      await saveReaderPosition(1, "transcript", 5, 8, new Date(), testDb);

      expect((await getReaderPosition(1, "publication", 5, testDb))?.page).toBe(3);
      expect((await getReaderPosition(1, "transcript", 5, testDb))?.page).toBe(8);
    });

    it("should return only the asking user's position", async (ctx) => {
      if (!reachable) return ctx.skip();
      await saveReaderPosition(2, "publication", 7, 30, new Date(), testDb);

      expect(await getReaderPosition(1, "publication", 7, testDb)).toBeNull();
    });

    it("should refuse an unknown document type and a page below 1", async (ctx) => {
      if (!reachable) return ctx.skip();

      await expect(
        sql`INSERT INTO reader_positions (user_id, document_type, document_id, page) VALUES (1, 'video', 1, 1)`,
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO reader_positions (user_id, document_type, document_id, page) VALUES (1, 'publication', 1, 0)`,
      ).rejects.toThrow();
    });
  });

  describe("page bookmarks", () => {
    it("should list a document's bookmarks in page order", async (ctx) => {
      if (!reachable) return ctx.skip();
      await addPageBookmark(1, "publication", 7, 12, testDb);
      await addPageBookmark(1, "publication", 7, 3, testDb);

      const pages = (await listDocumentPageBookmarks(1, "publication", 7, testDb)).map((b) => b.page);

      expect(pages).toEqual([3, 12]);
    });

    it("should add the same page once", async (ctx) => {
      if (!reachable) return ctx.skip();
      const first = await addPageBookmark(1, "publication", 7, 12, testDb);

      const again = await addPageBookmark(1, "publication", 7, 12, testDb);

      expect(await count("reader_page_bookmarks")).toBe(1);
      expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
    });

    it("should remove a page, and accept removing one that is not there", async (ctx) => {
      if (!reachable) return ctx.skip();
      await addPageBookmark(1, "publication", 7, 12, testDb);

      await removePageBookmark(1, "publication", 7, 12, testDb);
      await removePageBookmark(1, "publication", 7, 12, testDb);

      expect(await count("reader_page_bookmarks")).toBe(0);
    });

    it("should never touch another user's bookmarks", async (ctx) => {
      if (!reachable) return ctx.skip();
      await addPageBookmark(2, "publication", 7, 12, testDb);

      await removePageBookmark(1, "publication", 7, 12, testDb);

      expect(await listDocumentPageBookmarks(1, "publication", 7, testDb)).toEqual([]);
      expect(await listUserPageBookmarks(1, testDb)).toEqual([]);
      expect((await listUserPageBookmarks(2, testDb)).map((b) => b.page)).toEqual([12]);
    });

    it("should list all of a user's bookmarks across documents, newest first", async (ctx) => {
      if (!reachable) return ctx.skip();
      await addPageBookmark(1, "publication", 7, 3, testDb);
      await sql`UPDATE reader_page_bookmarks SET created_at = now() - interval '1 day'`;
      await addPageBookmark(1, "transcript", 4, 20, testDb);

      const rows = await listUserPageBookmarks(1, testDb);

      expect(rows.map((r) => [r.documentType, r.documentId, r.page])).toEqual([
        ["transcript", 4, 20],
        ["publication", 7, 3],
      ]);
    });
  });

  it("should drop a user's reader state when the user is deleted", async (ctx) => {
    if (!reachable) return ctx.skip();
    await saveReaderPosition(1, "publication", 7, 3, new Date(), testDb);
    await addPageBookmark(1, "publication", 7, 3, testDb);

    await sql`DELETE FROM users WHERE id = 1`;

    expect(await count("reader_positions")).toBe(0);
    expect(await count("reader_page_bookmarks")).toBe(0);
  });
});
