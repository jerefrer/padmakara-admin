import { describe, it, expect } from "vitest";
import {
  ensureIncreasingWhen,
  type MigrationJournal,
} from "../../src/scripts/generate-migration.ts";

const DAY_MS = 86_400_000;

function journalWith(whens: number[]): MigrationJournal {
  return {
    version: "7",
    dialect: "postgresql",
    entries: whens.map((when, idx) => ({
      idx,
      version: "7",
      when,
      tag: `${String(idx).padStart(4, "0")}_m${idx}`,
      breakpoints: true,
    })),
  };
}

describe("ensureIncreasingWhen", () => {
  it("should leave the journal untouched when timestamps already increase", () => {
    const journal = journalWith([1000, 2000, 3000]);

    const { journal: result, changed } = ensureIncreasingWhen(journal);

    expect(changed).toEqual([]);
    expect(result).toEqual(journalWith([1000, 2000, 3000]));
  });

  it("should move a new entry one day after the previous one when it was stamped earlier", () => {
    // Hand-written entries carry future timestamps; drizzle-kit stamps the
    // new entry with the current time, which sorts before them.
    const journal = journalWith([1_811_814_400_000, 1_811_900_800_000, 1_792_676_240_281]);

    const { journal: result, changed } = ensureIncreasingWhen(journal);

    expect(result.entries[2]?.when).toBe(1_811_900_800_000 + DAY_MS);
    expect(changed).toEqual(["0002_m2"]);
  });

  it("should keep several new entries increasing after the last hand-written one", () => {
    const journal = journalWith([5 * DAY_MS, 1000, 2000]);

    const { journal: result } = ensureIncreasingWhen(journal);

    expect(result.entries.map((e) => e.when)).toEqual([5 * DAY_MS, 6 * DAY_MS, 7 * DAY_MS]);
  });

  it("should not mutate the journal it is given", () => {
    const journal = journalWith([2000, 1000]);

    ensureIncreasingWhen(journal);

    expect(journal.entries[1]?.when).toBe(1000);
  });
});
