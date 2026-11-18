/**
 * Backfill transcripts.page_count from the stored PDFs.
 *
 * Uploads from the admin never set page_count, and the legacy seed copied the
 * event's first transcript page count onto every transcript of the event, so
 * the column is missing or wrong for existing rows. New uploads are counted by
 * the API on create (routes/admin/transcripts.ts); this script fixes the rest.
 *
 * Read-only by default: it downloads each PDF, counts its pages with pdfinfo
 * and prints what would change. Pass --apply to write.
 *
 * Usage:
 *   bun run src/scripts/backfill-transcript-page-counts.ts            # dry run
 *   bun run src/scripts/backfill-transcript-page-counts.ts --apply    # write
 */
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { getObjectBytes } from "../services/s3.ts";
import { getPdfPageCount } from "../services/pdf-page-count.ts";

export interface TranscriptPageRow {
  id: number;
  s3Key: string | null;
  pageCount: number | null;
}

export interface PageCountChange {
  id: number;
  from: number | null;
  to: number;
}

export interface PageCountPlan {
  changes: PageCountChange[];
  unchanged: number;
  failures: Array<{ id: number; error: string }>;
}

/** Count each row's PDF and list the rows whose stored page count differs. */
export async function planPageCountBackfill(
  rows: TranscriptPageRow[],
  countPages: (s3Key: string) => Promise<number>,
): Promise<PageCountPlan> {
  const plan: PageCountPlan = { changes: [], unchanged: 0, failures: [] };
  for (const row of rows) {
    if (!row.s3Key) continue;
    try {
      const pages = await countPages(row.s3Key);
      if (pages === row.pageCount) plan.unchanged++;
      else plan.changes.push({ id: row.id, from: row.pageCount, to: pages });
    } catch (err) {
      plan.failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return plan;
}

async function countStoredPdfPages(s3Key: string): Promise<number> {
  const { body } = await getObjectBytes(s3Key);
  return getPdfPageCount(body);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = await db
    .select({ id: transcripts.id, s3Key: transcripts.s3Key, pageCount: transcripts.pageCount })
    .from(transcripts)
    .where(isNotNull(transcripts.s3Key))
    .orderBy(transcripts.id);

  console.log(`${rows.length} transcript(s) with a file. ${apply ? "APPLY" : "Dry run (pass --apply to write)"}`);
  const plan = await planPageCountBackfill(rows, countStoredPdfPages);

  for (const change of plan.changes) {
    console.log(`  #${change.id}: ${change.from ?? "null"} -> ${change.to}`);
  }
  for (const failure of plan.failures) {
    console.error(`  #${failure.id}: could not count pages (${failure.error})`);
  }
  console.log(`${plan.changes.length} to change, ${plan.unchanged} already right, ${plan.failures.length} failed.`);

  if (!apply) return;
  for (const change of plan.changes) {
    // updatedAt is left alone on purpose: the file did not change, so the app need not refetch it
    await db.update(transcripts).set({ pageCount: change.to }).where(eq(transcripts.id, change.id));
  }
  console.log(`Wrote ${plan.changes.length} page count(s).`);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
