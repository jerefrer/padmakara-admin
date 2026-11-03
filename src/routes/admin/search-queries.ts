import { Hono } from "hono";
import { AppError } from "../../lib/errors.ts";
import { getSearchStats, STATS_DAY_OPTIONS } from "../../services/search-log.ts";

/**
 * Aggregated, anonymous search statistics for the admin "Searches" page.
 */
const searchQueryRoutes = new Hono();

/**
 * GET /admin/search-queries/stats?days=30|90|365|730
 *
 * Returns { top, noResults, total } for the window. Defaults to 30 days.
 */
searchQueryRoutes.get("/stats", async (c) => {
  const days = Number(c.req.query("days") ?? "30");
  if (!(STATS_DAY_OPTIONS as readonly number[]).includes(days)) {
    throw AppError.badRequest("days must be one of 30, 90, 365, 730", "VALIDATION_ERROR");
  }
  return c.json(await getSearchStats(days));
});

export { searchQueryRoutes };
