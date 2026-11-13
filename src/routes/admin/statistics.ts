import { Hono } from "hono";
import { getStatistics, resolveRange } from "../../services/statistics.ts";

/**
 * Aggregate usage statistics for the admin "Statistics" page. Totals only:
 * nothing in the response identifies a person.
 */
const statisticsRoutes = new Hono();

/** GET /admin/statistics?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 30 days) */
statisticsRoutes.get("/", async (c) => {
  const range = resolveRange(c.req.query("from"), c.req.query("to"));
  return c.json(await getStatistics(range));
});

export { statisticsRoutes };
