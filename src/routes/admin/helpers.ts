import type { Context } from "hono";
import { sql, eq, asc, desc, type SQL, type Column } from "drizzle-orm";
import { paginationSchema } from "../../lib/schemas.ts";
import { db } from "../../db/index.ts";

/**
 * Parse React Admin pagination/sort params from query string.
 */
export function parsePagination(c: Context) {
  const raw = c.req.query();
  const params = paginationSchema.parse(raw);
  const limit = params._end - params._start;
  const offset = params._start;
  return { ...params, limit, offset };
}

/**
 * Build an ORDER BY clause from React Admin sort params.
 * `columns` maps field names to Drizzle column references.
 */
export function buildOrderBy(
  sortField: string,
  sortOrder: string,
  columns: Record<string, Column>,
): SQL | undefined {
  const col = columns[sortField];
  if (!col) return undefined;
  return sortOrder === "DESC" ? desc(col) : asc(col);
}

/**
 * Send a React Admin compatible list response with Content-Range header.
 */
export function listResponse<T>(
  c: Context,
  data: T[],
  total: number,
  start: number,
  end: number,
  resource: string,
) {
  const actualEnd = Math.min(start + data.length - 1, end - 1);
  c.header("Content-Range", `${resource} ${start}-${actualEnd}/${total}`);
  c.header("Access-Control-Expose-Headers", "Content-Range");
  return c.json(data);
}

/**
 * Count rows in a table, optionally filtered.
 */
export async function countRows(table: any, where?: SQL): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return result?.count ?? 0;
}
