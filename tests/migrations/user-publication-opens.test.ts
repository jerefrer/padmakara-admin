import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schemaTables from "../../src/db/schema/index.ts";
import type { Database } from "../../src/db/index.ts";
import {
  lastOpenedByPublication,
  recordPublicationOpen,
} from "../../src/services/publication-opens.ts";

// Runs 0077_user_publication_opens.sql in a throwaway schema of the test
// database, on minimal copies of users and publications, then runs the
// service queries against it. Skipped when no database is reachable.

const url = process.env.DATABASE_URL!;
const schema = `mig0077_${process.pid}`;
const migration = readFileSync(
  path.join(import.meta.dirname, "../../src/db/migrations/0077_user_publication_opens.sql"),
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

describe("0077_user_publication_opens.sql", () => {
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
    await sql.unsafe(`CREATE TABLE ${schema}.publications (id serial PRIMARY KEY)`);
    await sql.unsafe(`INSERT INTO ${schema}.users DEFAULT VALUES; INSERT INTO ${schema}.users DEFAULT VALUES`);
    await sql.unsafe(
      `INSERT INTO ${schema}.publications DEFAULT VALUES; INSERT INTO ${schema}.publications DEFAULT VALUES`,
    );
    await sql.unsafe(migration);
  });

  afterAll(async () => {
    if (reachable) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  });

  it("should apply twice without error", async (ctx) => {
    if (!reachable) return ctx.skip();

    await sql.unsafe(migration);

    expect(await count("user_publication_opens")).toBe(0);
  });

  it("should keep one row per user and publication, moving its time forward on each open", async (ctx) => {
    if (!reachable) return ctx.skip();
    await recordPublicationOpen(1, 1, testDb);
    await sql`UPDATE user_publication_opens SET last_opened_at = now() - interval '1 day'`;

    await recordPublicationOpen(1, 1, testDb);

    // Compared in SQL: drizzle replaces this client's timestamp parsing.
    const rows = await sql<{ open_count: number; reopened_now: boolean }[]>`
      SELECT open_count, last_opened_at > now() - interval '1 hour' AS reopened_now
      FROM user_publication_opens`;
    expect(rows).toEqual([{ open_count: 2, reopened_now: true }]);
  });

  it("should return only the asking user's opens", async (ctx) => {
    if (!reachable) return ctx.skip();
    await recordPublicationOpen(1, 1, testDb);
    await recordPublicationOpen(2, 2, testDb);

    const mine = await lastOpenedByPublication(1, [1, 2], testDb);

    expect([...mine.keys()]).toEqual([1]);
    expect(mine.get(1)).toBeInstanceOf(Date);
  });

  it("should return nothing for publications outside the requested ids", async (ctx) => {
    if (!reachable) return ctx.skip();
    await recordPublicationOpen(1, 1, testDb);

    expect((await lastOpenedByPublication(1, [2], testDb)).size).toBe(0);
    expect((await lastOpenedByPublication(1, [], testDb)).size).toBe(0);
  });

  it("should drop a user's opens when the user is deleted", async (ctx) => {
    if (!reachable) return ctx.skip();
    await recordPublicationOpen(1, 1, testDb);

    await sql`DELETE FROM users WHERE id = 1`;

    expect(await count("user_publication_opens")).toBe(0);
  });

  it("should drop a publication's opens when the publication is deleted", async (ctx) => {
    if (!reachable) return ctx.skip();
    await recordPublicationOpen(1, 2, testDb);

    await sql`DELETE FROM publications WHERE id = 2`;

    expect(await count("user_publication_opens")).toBe(0);
  });
});
