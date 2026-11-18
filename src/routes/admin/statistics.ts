import { Hono } from "hono";
import { AppError } from "../../lib/errors.ts";
import { getEventStatistics, getStatistics, resolveRange } from "../../services/statistics.ts";

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

/** GET /admin/statistics/events/:id?from&to — per-track, per-video and per-document counts for one teaching. */
statisticsRoutes.get("/events/:id", async (c) => {
  const raw = c.req.param("id");
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest("Invalid event id", "VALIDATION_ERROR");
  }
  const range = resolveRange(c.req.query("from"), c.req.query("to"));
  return c.json(await getEventStatistics(id, range));
});

export { statisticsRoutes };
