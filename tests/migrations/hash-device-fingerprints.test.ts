import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hashDeviceFingerprint } from "../../src/lib/device-fingerprint.ts";

// Runs 0072_hash_device_fingerprints.sql in a throwaway schema of the test
// database, on a minimal copy of the two tables it touches. Skipped when no
// database is reachable.

const url = process.env.DATABASE_URL!;
const schema = `mig0072_${process.pid}`;
const migration = readFileSync(
  path.join(import.meta.dirname, "../../src/db/migrations/0072_hash_device_fingerprints.sql"),
  "utf8",
);

const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
let reachable = true;

const legacyJson = Buffer.from(
  JSON.stringify({ platform: "ios", brand: "Apple", modelName: "iPhone 15", osVersion: "18.1", timestamp: 1, random: "x" }),
).toString("base64");
const accented = "android-1731000000000-0.abc — Galaxy “S24”";
const currentFormat = "A".repeat(42) + "_";

async function seed() {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await sql.unsafe(
    `CREATE TABLE device_activations (id serial PRIMARY KEY, device_fingerprint text NOT NULL UNIQUE)`,
  );
  await sql.unsafe(`CREATE TABLE magic_link_tokens (id serial PRIMARY KEY, device_fingerprint text)`);
  for (const fp of [legacyJson, accented, currentFormat]) {
    await sql`INSERT INTO device_activations (device_fingerprint) VALUES (${fp})`;
  }
  await sql`INSERT INTO magic_link_tokens (device_fingerprint) VALUES (${"backoffice:abcdef0123456789"}), (${legacyJson}), (NULL)`;
}

async function fingerprints(table: string) {
  const rows = await sql.unsafe<{ device_fingerprint: string | null }[]>(
    `SELECT device_fingerprint FROM ${table} ORDER BY id`,
  );
  return rows.map((r) => r.device_fingerprint);
}

describe("0072_hash_device_fingerprints.sql", () => {
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

  it("should store the same SHA-256 hex the API computes, in both tables", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed();

    await sql.unsafe(migration);

    expect(await fingerprints("device_activations")).toEqual(
      [legacyJson, accented, currentFormat].map(hashDeviceFingerprint),
    );
    expect(await fingerprints("magic_link_tokens")).toEqual([
      hashDeviceFingerprint("backoffice:abcdef0123456789"),
      hashDeviceFingerprint(legacyJson),
      null,
    ]);
  });

  it("should leave already-hashed rows untouched when run a second time", async (ctx) => {
    if (!reachable) return ctx.skip();
    await seed();
    await sql.unsafe(migration);
    const once = await fingerprints("device_activations");

    await sql.unsafe(migration);

    expect(await fingerprints("device_activations")).toEqual(once);
  });
});
