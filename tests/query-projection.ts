/**
 * Test helpers for "no storage key leaves the server" checks.
 *
 * Route tests mock the database, so a mocked `findMany` would hand back every
 * fixture field whatever the query asked for, and an explicit column list could
 * not be tested. `projectRow` applies a relational query's `columns` and `with`
 * to a fixture row the way Drizzle does: listed columns only (or all but the
 * excluded ones), and only the relations the query loads.
 */

/** Relation names in the fixtures; any other key is a column. */
const RELATIONS = new Set([
  "audience",
  "eventType",
  "eventTeachers",
  "eventRetreatGroups",
  "eventPlaces",
  "eventOrganizers",
  "eventPublications",
  "videos",
  "sessions",
  "tracks",
  "transcripts",
  "eventFiles",
  "session",
  "event",
  "track",
  "video",
  "teacher",
  "retreatGroup",
  "place",
  "organizer",
  "publication",
]);

interface QueryConfig {
  columns?: Record<string, boolean>;
  with?: Record<string, unknown>;
}

function projectValue(value: unknown, config: unknown): unknown {
  const nested: QueryConfig = config && typeof config === "object" ? (config as QueryConfig) : {};
  if (Array.isArray(value)) return value.map((item) => projectRow(item, nested));
  if (value && typeof value === "object") return projectRow(value as Record<string, unknown>, nested);
  return value;
}

export function projectRow<T>(row: T, config: QueryConfig = {}): T {
  if (!row || typeof row !== "object") return row;
  const source = row as Record<string, unknown>;
  const columns = config.columns ?? {};
  const included = Object.entries(columns).filter(([, on]) => on).map(([name]) => name);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (RELATIONS.has(key)) {
      if (config.with && key in config.with) out[key] = projectValue(structuredClone(value), config.with[key]);
      continue;
    }
    if (included.length > 0 ? !included.includes(key) : columns[key] === false) continue;
    out[key] = structuredClone(value);
  }
  return out as T;
}

/** Paths in a JSON payload whose key names a storage key (`s3Key`, `heroS3Key`, ...). */
export function storageKeyPaths(payload: unknown, path = "$"): string[] {
  if (Array.isArray(payload)) return payload.flatMap((item, i) => storageKeyPaths(item, `${path}[${i}]`));
  if (!payload || typeof payload !== "object") return [];
  return Object.entries(payload).flatMap(([key, value]) => [
    ...(/s3key$/i.test(key) ? [`${path}.${key}`] : []),
    ...storageKeyPaths(value, `${path}.${key}`),
  ]);
}
