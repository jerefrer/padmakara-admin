import { desc, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { cspReports } from "../db/schema/csp-reports.ts";
import { config } from "../config.ts";

/**
 * Content-Security-Policy violation reports.
 *
 * Browsers POST these to a public endpoint, so everything in a report is
 * attacker-controlled and may carry personal data (presigned storage URLs,
 * tokens in query strings, the visitor's address). Each field is therefore
 * reduced to a coarse, bounded value before anything is stored.
 */

export type CspSite = "app" | "admin" | "other";

export interface CspViolation {
  site: CspSite;
  directive: string;
  blocked: string;
  source: string;
  lineNumber: number | null;
  columnNumber: number | null;
  disposition: "report" | "enforce";
}

const MAX_REPORTS_PER_REQUEST = 10;
const MAX_FIELD_LENGTH = 300;

/** Blocked-URI values that are keywords rather than addresses. */
const BLOCKED_KEYWORDS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "data",
  "blob",
  "self",
  "filesystem",
  "about",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1e9
    ? value
    : null;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** scheme://host[:port], never a path or query. */
function schemeAndHost(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

export function siteOf(documentUri: string | null): CspSite {
  const url = documentUri ? parseUrl(documentUri) : null;
  if (!url) return "other";
  const origin = url.origin;
  const originOf = (u: string) => parseUrl(u)?.origin;
  if (origin === originOf(config.urls.frontend)) return "app";
  if (origin === originOf(config.urls.admin)) return "admin";
  return "other";
}

/** "https://x.b-cdn.net/a?token=1" -> "https://x.b-cdn.net"; "data:..." -> "data". */
export function reduceBlocked(raw: string | null): string {
  if (!raw) return "unknown";
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (BLOCKED_KEYWORDS.has(lower)) return lower;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1];
  if (scheme === "data" || scheme === "blob" || scheme === "about" || scheme === "filesystem") {
    return scheme;
  }
  const url = parseUrl(trimmed);
  if (!url || !url.host) return "unknown";
  return schemeAndHost(url).slice(0, MAX_FIELD_LENGTH);
}

/** Source file as origin + path, with no query string or fragment; "" when absent. */
export function reduceSource(raw: string | null): string {
  if (!raw) return "";
  const url = parseUrl(raw.trim());
  if (!url || !url.host) return "";
  return `${schemeAndHost(url)}${url.pathname}`.slice(0, MAX_FIELD_LENGTH);
}

/** First token of a directive such as "script-src-elem 'self' https:". */
function reduceDirective(raw: string | null): string | null {
  const token = raw?.trim().split(/\s+/)[0]?.toLowerCase();
  return token && /^[a-z][a-z-]{1,40}$/.test(token) ? token : null;
}

function toViolation(body: unknown): CspViolation | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  // Legacy report-uri keys are kebab-case, the Reporting API ones camelCase.
  const directive = reduceDirective(
    asString(b["effective-directive"]) ??
      asString(b.effectiveDirective) ??
      asString(b["violated-directive"]) ??
      asString(b.violatedDirective),
  );
  if (!directive) return null;
  const disposition = asString(b.disposition) === "enforce" ? "enforce" : "report";
  return {
    site: siteOf(asString(b["document-uri"]) ?? asString(b.documentURL) ?? asString(b.documentURI)),
    directive,
    blocked: reduceBlocked(
      asString(b["blocked-uri"]) ?? asString(b.blockedURL) ?? asString(b.blockedURI),
    ),
    source: reduceSource(asString(b["source-file"]) ?? asString(b.sourceFile)),
    lineNumber: asPosition(b["line-number"] ?? b.lineNumber),
    columnNumber: asPosition(b["column-number"] ?? b.columnNumber),
    disposition,
  };
}

/**
 * Violations in a request body, accepting both formats browsers send: the
 * legacy `{"csp-report": {...}}` object (report-uri) and the Reporting API
 * array of `{type: "csp-violation", body: {...}}`. Anything else yields [].
 */
export function parseCspPayload(text: string): CspViolation[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const bodies: unknown[] = [];
  if (Array.isArray(data)) {
    for (const entry of data.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "csp-violation") {
        bodies.push((entry as { body?: unknown }).body);
      }
    }
  } else if (typeof data === "object" && data !== null && "csp-report" in data) {
    bodies.push((data as Record<string, unknown>)["csp-report"]);
  }
  return bodies.flatMap((b) => {
    const v = toViolation(b);
    return v ? [v] : [];
  });
}

/**
 * Coarse browser family and major version, e.g. "Safari 18" or "Chrome 132".
 * The raw user agent is never stored.
 */
export function browserFamily(userAgent: string | undefined): string {
  if (!userAgent) return "unknown";
  const patterns: [string, RegExp][] = [
    ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /\bOPR\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [name, re] of patterns) {
    const major = re.exec(userAgent)?.[1];
    if (major) return `${name} ${major}`;
  }
  return "other";
}

/** Store one violation, or bump the counter of the identical one already stored. */
export async function recordCspViolation(v: CspViolation, browser: string): Promise<void> {
  await db
    .insert(cspReports)
    .values({
      site: v.site,
      directive: v.directive,
      blocked: v.blocked,
      source: v.source,
      lineNumber: v.lineNumber,
      columnNumber: v.columnNumber,
      disposition: v.disposition,
      browser,
    })
    .onConflictDoUpdate({
      target: [cspReports.site, cspReports.directive, cspReports.blocked, cspReports.source],
      set: {
        count: sql`${cspReports.count} + 1`,
        lastSeen: sql`now()`,
        lineNumber: v.lineNumber,
        columnNumber: v.columnNumber,
        disposition: v.disposition,
        browser,
      },
    });
}

/** Every stored row, most frequent first. */
export async function listCspReports() {
  return db
    .select()
    .from(cspReports)
    .orderBy(desc(cspReports.count), desc(cspReports.lastSeen))
    .limit(1000);
}
