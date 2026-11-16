import { Hono } from "hono";
import { listCspReports } from "../../services/csp-reports.ts";

/**
 * Read-only view of the deduplicated CSP violation reports.
 */
const cspReportAdminRoutes = new Hono();

/** GET /admin/csp-reports: every row, most frequent first. */
cspReportAdminRoutes.get("/", async (c) => {
  const reports = await listCspReports();
  return c.json({ reports, total: reports.length });
});

export { cspReportAdminRoutes };
