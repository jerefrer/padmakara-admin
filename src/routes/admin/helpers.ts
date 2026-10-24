import type { Context } from "hono";
import { sql, type SQL, type Column } from "drizzle-orm";
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

/** A whitelisted sort target: a table column or a prebuilt SQL expression (e.g. a subquery). */
export type SortTarget = Column | SQL;

/**
 * Build an ORDER BY clause from React Admin sort params.
 * `columns` maps the sort keys the admin may send to a column or SQL expression.
 * Only keys present in the map are honoured: anything else returns undefined, so
 * client input never reaches the SQL text. NULLs always sort last, in both directions.
 */
export function buildOrderBy(
  sortField: string,
  sortOrder: string,
  columns: Record<string, SortTarget>,
): SQL | undefined {
  // hasOwn: keys such as "constructor" must not resolve through the prototype chain.
  if (!Object.hasOwn(columns, sortField)) return undefined;
  const target = columns[sortField];
  return sortOrder === "DESC" ? sql`${target} desc nulls last` : sql`${target} asc nulls last`;
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
