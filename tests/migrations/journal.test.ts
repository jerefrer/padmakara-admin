import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Invariants drizzle-kit and drizzle-orm's migrator rely on, checked on the
// committed migration folder.

const migrationsDir = path.join(import.meta.dirname, "../../src/db/migrations");
const metaDir = path.join(migrationsDir, "meta");
const journal = JSON.parse(readFileSync(path.join(metaDir, "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("migration journal", () => {
  it("should have strictly increasing timestamps so the migrator applies every entry", () => {
    // drizzle-orm skips any migration whose `when` is not greater than the
    // last applied one, without reporting it.
    const outOfOrder = journal.entries.filter((entry, i) => {
      const previous = journal.entries[i - 1];
      return previous !== undefined && entry.when <= previous.when;
    });

    expect(outOfOrder.map((e) => e.tag)).toEqual([]);
  });

  it("should have a SQL file for every entry", () => {
    const sqlFiles = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")));

    const missing = journal.entries.filter((e) => !sqlFiles.has(`${e.tag}.sql`));

    expect(missing.map((e) => e.tag)).toEqual([]);
  });

  it("should have a snapshot for the latest migration so drizzle-kit generate diffs from it", () => {
    // drizzle-kit generate diffs against the last snapshot file by name. A
    // migration added without a snapshot would be planned again next time.
    const snapshots = readdirSync(metaDir)
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort();
    const latestPrefix = journal.entries.at(-1)!.tag.split("_")[0]; // journal is never empty

    expect(snapshots.at(-1)).toBe(`${latestPrefix}_snapshot.json`);
  });
});
