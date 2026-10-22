/**
 * `bun run db:generate [drizzle-kit options]`
 *
 * Runs `drizzle-kit generate`, then makes sure the journal's `when`
 * timestamps still increase.
 *
 * Why: migrations 0005-0041 were hand-written with made-up timestamps that
 * lie in the future (0041 is dated 2027-06-02). drizzle-kit stamps a new
 * entry with the current time, which sorts before them, and drizzle-orm's
 * migrator silently skips any migration whose `when` is not greater than the
 * last applied one. So a freshly generated migration is moved one day after
 * the previous entry. Entries that already increase are never touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const DAY_MS = 86_400_000;

export function ensureIncreasingWhen(journal: MigrationJournal): {
  journal: MigrationJournal;
  changed: string[];
} {
  const changed: string[] = [];
  const entries: JournalEntry[] = [];
  for (const entry of journal.entries) {
    const previous = entries.at(-1);
    if (previous && entry.when <= previous.when) {
      entries.push({ ...entry, when: previous.when + DAY_MS });
      changed.push(entry.tag);
    } else {
      entries.push({ ...entry });
    }
  }
  return { journal: { ...journal, entries }, changed };
}

async function main(): Promise<void> {
  const generate = Bun.spawn(["bunx", "drizzle-kit", "generate", ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await generate.exited;
  if (exitCode !== 0) process.exit(exitCode);

  const journalPath = path.join(import.meta.dirname, "../db/migrations/meta/_journal.json");
  const original = JSON.parse(readFileSync(journalPath, "utf8")) as MigrationJournal;
  const { journal, changed } = ensureIncreasingWhen(original);
  if (changed.length === 0) return;

  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  for (const tag of changed) {
    const entry = journal.entries.find((e) => e.tag === tag);
    console.log(`Journal: moved ${tag} to ${new Date(entry!.when).toISOString()} so the migrator applies it`); // entry comes from `changed`, so it exists
  }
}

if (import.meta.main) {
  await main();
}
