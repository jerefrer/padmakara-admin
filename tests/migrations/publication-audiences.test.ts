import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";

// Runs 0039_publication_audiences.sql in a throwaway schema of the test
// database, on a minimal copy of the tables it touches. Skipped when no
// database is reachable.

const url = process.env.DATABASE_URL!;
const schema = `mig0039_${process.pid}`;
const migration = readFileSync(
  path.join(import.meta.dirname, "../../src/db/migrations/0039_publication_audiences.sql"),
  "utf8",
);

const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
let reachable = true;

async function seed(withAudiences: boolean, accessLevels: string[]) {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await sql.unsafe(`CREATE TABLE audiences (id serial PRIMARY KEY, slug text NOT NULL UNIQUE)`);
  await sql.unsafe(
    `CREATE TABLE publications (id serial PRIMARY KEY, title text, access_level text NOT NULL DEFAULT 'public')`,
  );
  if (withAudiences) {
    await sql.unsafe(
      `INSERT INTO audiences (slug) VALUES ('free-anyone'), ('free-subscribers'), ('event-participants')`,
    );
  }
  for (const level of accessLevels) {
    await sql.unsafe(`INSERT INTO publications (title, access_level) VALUES ('t', '${level}')`);
  }
}

describe("0039_publication_audiences.sql", () => {
  beforeAll(async () => {
    try {
      await sql`SELECT 1`;
    } catch {
      reachable = false;
    }
  });

  afterAll(async () => {
    if (reachable) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  });

  it("should map public, subscribers and events to free-anyone, free-subscribers and event-participants, then drop access_level", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed(true, ["public", "subscribers", "events", "public"]);

    await sql.unsafe(migration);

    const rows = await sql<{ slug: string }[]>`
      SELECT a.slug FROM publications p JOIN audiences a ON a.id = p.audience_id ORDER BY p.id`;
    expect(rows.map((r) => r.slug)).toEqual([
      "free-anyone",
      "free-subscribers",
      "event-participants",
      "free-anyone",
    ]);
    const columns = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'publications' AND column_name = 'access_level'`;
    expect(columns).toHaveLength(0);
  });

  it("should be safe to run again once access_level is gone", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed(true, ["public", "subscribers"]);
    await sql.unsafe(migration);

    await sql.unsafe(migration);

    const rows = await sql`SELECT audience_id FROM publications`;
    expect(rows.every((r) => r.audience_id !== null)).toBe(true);
  });

  it("should refuse to drop access_level when a publication cannot be mapped", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed(false, ["public"]);

    await expect(sql.unsafe(migration)).rejects.toThrow(/without an audience/);

    const columns = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'publications' AND column_name = 'access_level'`;
    expect(columns).toHaveLength(1);
  });
});
