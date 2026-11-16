/**
 * Read-only summary of the stored Content-Security-Policy violation reports,
 * most frequent first.
 *
 *   bun run src/scripts/csp-report-summary.ts
 *
 * Reads DATABASE_URL like the API does. Writes nothing.
 */
import { listCspReports } from "../services/csp-reports.ts";

const rows = await listCspReports();

if (rows.length === 0) {
  console.log("No CSP violation reports stored.");
  process.exit(0);
}

console.table(
  rows.map((r) => ({
    count: r.count,
    site: r.site,
    directive: r.directive,
    blocked: r.blocked,
    source: r.source,
    pos: r.lineNumber === null ? "" : `${r.lineNumber}:${r.columnNumber ?? ""}`,
    disposition: r.disposition,
    browser: r.browser,
    first_seen: r.firstSeen.toISOString(),
    last_seen: r.lastSeen.toISOString(),
  })),
);
console.log(`${rows.length} distinct violation(s), ${rows.reduce((n, r) => n + r.count, 0)} report(s).`);
process.exit(0);
