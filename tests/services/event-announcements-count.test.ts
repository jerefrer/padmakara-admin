import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Every count query resolves to one row; the where clauses are kept to check what is counted.
const { wheres, tables } = vi.hoisted(() => ({ wheres: [] as unknown[], tables: [] as unknown[] }));

vi.mock("../../src/db/index.ts", () => {
  const chain = (): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    node.from = vi.fn((table: unknown) => {
      tables.push(table);
      return node;
    });
    node.innerJoin = vi.fn(() => node);
    node.where = vi.fn((cond: unknown) => {
      wheres.push(cond);
      return Promise.resolve([{ n: 2 }]);
    });
    return node;
  };
  return { db: { select: vi.fn(() => chain()) } };
});

import { countAnnounceableContent } from "../../src/services/event-announcements.ts";
import { transcripts } from "../../src/db/schema/transcripts.ts";

describe("countAnnounceableContent", () => {
  it("should count only published transcript files", async () => {
    await countAnnounceableContent(7);

    const index = tables.indexOf(transcripts);
    const { sql } = new PgDialect().sqlToQuery(wheres[index] as SQL);
    expect(sql).toContain('"transcripts"."published" = $');
  });
});
