import { and, count, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { searchQueries } from "../db/schema/search-queries.ts";

/** Rows older than this many months are deleted. */
export const RETENTION_MONTHS = 24;
const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Trim, collapse whitespace, lowercase, cap length. Returns null if too short to log. */
export function normalizeLoggedQuery(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, MAX_QUERY_LENGTH).trim();
  return q.length >= MIN_QUERY_LENGTH ? q : null;
}

/**
 * Store one anonymous search. Takes only the search itself: there is
 * intentionally no way to pass who made it.
 */
export async function recordSearch(input: {
  query: string;
  resultCount: number;
  language?: "en" | "pt";
}): Promise<boolean> {
  const query = normalizeLoggedQuery(input.query);
  if (!query) return false;
  await db.insert(searchQueries).values({
    query,
    resultCount: input.resultCount,
    language: input.language ?? null,
  });
  return true;
}

/** Delete rows older than the retention window. */
export async function purgeOldSearches(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  await db.delete(searchQueries).where(lt(searchQueries.createdAt, cutoff));
}

let lastPurgeAt = 0;

/**
 * There is no scheduler in the API, so the purge runs opportunistically from
 * the log endpoint, at most once per day per process. Failures never affect
 * the caller.
 */
export function purgeIfDue(nowMs: number = Date.now()): void {
  if (nowMs - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = nowMs;
  purgeOldSearches(new Date(nowMs)).catch((err) => {
    console.error("search log purge failed", err);
  });
}

/** Test hook. */
export function resetPurgeStateForTests(): void {
  lastPurgeAt = 0;
}

export const STATS_DAY_OPTIONS = [30, 90, 365, 730] as const;

export interface SearchStatRow {
  query: string;
  count: number;
  lastAt: string;
}

async function topQueries(since: Date, onlyNoResults: boolean): Promise<SearchStatRow[]> {
  const where = onlyNoResults
    ? and(gte(searchQueries.createdAt, since), eq(searchQueries.resultCount, 0))
    : gte(searchQueries.createdAt, since);
  const rows = await db
    .select({
      query: searchQueries.query,
      count: count(),
      lastAt: max(searchQueries.createdAt),
    })
    .from(searchQueries)
    .where(where)
    .groupBy(searchQueries.query)
    .orderBy(desc(count()), desc(max(searchQueries.createdAt)))
    .limit(50);
  return rows.map((r) => ({
    query: r.query,
    count: Number(r.count),
    lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : "",
  }));
}

export async function getSearchStats(days: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [top, noResults, totalRows] = await Promise.all([
    topQueries(since, false),
    topQueries(since, true),
    db
      .select({ total: sql<number>`count(*)` })
      .from(searchQueries)
      .where(gte(searchQueries.createdAt, since)),
  ]);
  return { top, noResults, total: Number(totalRows[0]?.total ?? 0) };
}
