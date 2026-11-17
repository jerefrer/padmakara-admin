import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";

// Runs 0075_publication_status.sql in a throwaway schema of the test database,
// on a minimal copy of the publications table. Skipped when no database is
// reachable.

const url = process.env.DATABASE_URL!;
const schema = `mig0075_${process.pid}`;
const migration = readFileSync(
  path.join(import.meta.dirname, "../../src/db/migrations/0075_publication_status.sql"),
  "utf8",
);

const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
let reachable = true;

async function seed(statuses: (string | null)[]) {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await sql.unsafe(
    `CREATE TABLE publications (id serial PRIMARY KEY, title text, status text NOT NULL DEFAULT 'draft')`,
  );
  for (const status of statuses) {
    if (status === null) await sql.unsafe(`INSERT INTO publications (title) VALUES ('t')`);
    else await sql.unsafe(`INSERT INTO publications (title, status) VALUES ('t', '${status}')`);
  }
}

describe("0075_publication_status.sql", () => {
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

  it("should publish the publications left on the never-used 'draft' default", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed([null, null]);

    await sql.unsafe(migration);

    const rows = await sql<{ status: string }[]>`SELECT status FROM publications ORDER BY id`;
    expect(rows.map((r) => r.status)).toEqual(["published", "published"]);
  });

  it("should leave the column default at 'draft' for new publications", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed([null]);
    await sql.unsafe(migration);

    await sql.unsafe(`INSERT INTO publications (title) VALUES ('new')`);

    const [row] = await sql<{ status: string }[]>`SELECT status FROM publications WHERE title = 'new'`;
    expect(row!.status).toBe("draft");
  });

  it("should not touch a publication already forthcoming", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed(["forthcoming"]);

    await sql.unsafe(migration);

    const [row] = await sql<{ status: string }[]>`SELECT status FROM publications`;
    expect(row!.status).toBe("forthcoming");
  });
});
