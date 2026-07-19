/**
 * Import S3-hosted videos into Bunny Stream + event_videos.
 *
 * Replaces the obsolete Google-Drive ingestion script (import-drive-videos.ts).
 * The team's curated videos live in the `padmakara-pt-app` S3 bucket (not the
 * app's own `padmakara-content` bucket), one video per session recording, e.g.:
 *   https://padmakara-pt-app.s3.eu-west-3.amazonaws.com/Videos_for_app_testing/2009-06-TGR-LIS/2009-06-21-TGR-LIS.mp4
 *
 * Videos are stored per EVENT, not per session — the `--event <eventId>` CLI
 * arg already fixes the event for the whole run. The `sessions` table lookup
 * below is retained purely as a validation/metadata step: it confirms the
 * mapping entry's date/period actually matches a session that belongs to
 * this event, and it supplies `videoDate` + a title hint for the inserted row.
 *
 * Usage:
 *   bun src/scripts/import-s3-videos.ts --event <eventId> --input <mapping.json> [--dry-run]
 *
 * `mapping.json` is an array of entries, each with a `url` and OPTIONAL
 * resolution hints:
 *   [
 *     { "url": "https://.../2009-06-21-TGR-LIS.mp4" },
 *     { "url": ".../20219-10-09-KPS-...-MORNING-UBP.mp4", "date": "2019-10-09", "period": "morning" },
 *     { "url": ".../2018-07-YMR-LIS.mp4", "sessionId": 42 }
 *   ]
 *
 * Behavior:
 *   1. Per entry, resolve a matching `sessions` row (validation + metadata
 *      only):
 *        - `sessionId` given → use it directly.
 *        - else determine `date` (entry.date, or parsed from the URL's
 *          filename via parseVideoName) and `period` (entry.period, or
 *          parsed). Match `sessions` where eventId = <event> AND
 *          sessionDate = date AND (if period known) timePeriod = period.
 *          Zero or multiple matches → recorded as UNRESOLVED (skipped).
 *   2. `position` = current count of event_videos rows for the event
 *      (so re-runs / appends are ordered), computed once per event per run.
 *   3. Parses the S3 URL (`parseS3Url`), presigns a 6h GET on the API's own
 *      AWS creds (confirmed to have read access to padmakara-pt-app), and
 *      hands the presigned URL to Bunny's fetchVideo().
 *   4. Inserts an event_videos row:
 *        { eventId, bunnyVideoId: guid, position, titleEn, videoDate }
 *      titleEn is the capitalized period ("Morning"/"Afternoon") or null.
 *
 *   --dry-run prints the url → { sessionId, date, period, position }
 *   resolution table (and UNRESOLVED rows) and exits without presigning,
 *   calling Bunny, or writing to the database.
 *
 * NOTE on the real-world "20219" filename typo: some legacy filenames have a
 * typo'd 5-digit year segment, e.g. "20219-10-09-KPS-TEACHINGS-MORNING-UBP.mp4"
 * (should be "2019-10-09"). parseVideoName's date regex is word-boundary
 * anchored so it deliberately does NOT match a YYYY-MM-DD run embedded inside
 * a longer digit run — such names come back `date: null`, and the operator
 * MUST supply an explicit `date` hint in the mapping JSON for them.
 */
import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { fetchVideo } from "../services/bunny.ts";
import { config } from "../config.ts";

// Word-boundary anchored so it will NOT match inside a longer digit run —
// see the "20219" typo note in the file docstring.
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const MORNING_RE = /morning/i;
const AFTERNOON_RE = /afternoon/i;

export interface S3UrlParts {
  bucket: string;
  region: string;
  key: string;
}

/**
 * Parse an S3 object URL into `{ bucket, region, key }`.
 * Handles both:
 *   - virtual-hosted-style: https://bucket.s3.region.amazonaws.com/key
 *   - path-style:           https://s3.region.amazonaws.com/bucket/key
 * Returns null for anything else (not an S3 URL).
 */
export function parseS3Url(url: string): S3UrlParts | null {
  const virtualHosted = /^https?:\/\/([^./]+)\.s3\.([^./]+)\.amazonaws\.com\/(.+)$/.exec(url);
  if (virtualHosted) {
    const [, bucket, region, key] = virtualHosted;
    return { bucket: bucket!, region: region!, key: key! };
  }
  const pathStyle = /^https?:\/\/s3\.([^./]+)\.amazonaws\.com\/([^/]+)\/(.+)$/.exec(url);
  if (pathStyle) {
    const [, region, bucket, key] = pathStyle;
    return { bucket: bucket!, region: region!, key: key! };
  }
  return null;
}

export interface ParsedVideoName {
  date: string | null;
  period: "morning" | "afternoon" | null;
}

/**
 * Extract a session date + time-period hint from a video filename.
 *   - date: the first standalone YYYY-MM-DD run in the name, or null.
 *   - period: "morning" | "afternoon" from a case-insensitive substring
 *     match, else null.
 */
export function parseVideoName(filename: string): ParsedVideoName {
  const dateMatch = DATE_RE.exec(filename);
  const date = dateMatch ? dateMatch[0] : null;
  const period = MORNING_RE.test(filename) ? "morning" : AFTERNOON_RE.test(filename) ? "afternoon" : null;
  return { date, period };
}

export interface MappingEntry {
  url: string;
  date?: string;
  period?: string;
  sessionId?: number;
}

type SessionRow = typeof sessions.$inferSelect;

interface ResolvedEntry {
  entry: MappingEntry;
  session: SessionRow | null;
  date: string | null;
  period: string | null;
  reason?: string;
}

function filenameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  const parts = withoutQuery.split("/");
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a mapping entry to a single `sessions` row, or record why it
 * couldn't be resolved. Read-only — safe to call during --dry-run.
 */
async function resolveEntry(entry: MappingEntry, eventId: number): Promise<ResolvedEntry> {
  if (entry.sessionId != null) {
    const session = await db.query.sessions.findFirst({ where: eq(sessions.id, entry.sessionId) });
    if (!session) {
      return {
        entry,
        session: null,
        date: entry.date ?? null,
        period: entry.period ?? null,
        reason: `sessionId ${entry.sessionId} not found`,
      };
    }
    return { entry, session, date: session.sessionDate, period: session.timePeriod };
  }

  const parsed = parseVideoName(filenameFromUrl(entry.url));
  const date = entry.date ?? parsed.date;
  const period = entry.period ?? parsed.period;

  if (!date) {
    return { entry, session: null, date, period, reason: "no date (hint or parsed from filename)" };
  }

  const conditions = [eq(sessions.eventId, eventId), eq(sessions.sessionDate, date)];
  if (period) conditions.push(eq(sessions.timePeriod, period));
  const matches = await db
    .select()
    .from(sessions)
    .where(and(...conditions));

  if (matches.length !== 1) {
    return {
      entry,
      session: null,
      date,
      period,
      reason:
        matches.length === 0
          ? `no session matching eventId=${eventId} date=${date} period=${period ?? "any"}`
          : `${matches.length} sessions matched eventId=${eventId} date=${date} period=${period ?? "any"} (ambiguous)`,
    };
  }

  return { entry, session: matches[0]!, date, period };
}

const positionCounters = new Map<number, number>();

/**
 * Next 0-based position for an EVENT's video list, computed once per event
 * per run (starting from the current DB row count) so repeated entries in
 * one run are ordered sequentially. Read-only — safe to call during
 * --dry-run.
 */
async function nextPosition(eventId: number): Promise<number> {
  if (!positionCounters.has(eventId)) {
    const existing = await db.select().from(eventVideos).where(eq(eventVideos.eventId, eventId));
    positionCounters.set(eventId, existing.length);
  }
  const position = positionCounters.get(eventId)!;
  positionCounters.set(eventId, position + 1);
  return position;
}

function buildTitle(
  eventCode: string | null | undefined,
  eventId: number,
  date: string | null,
  period: string | null,
): string {
  const codeOrId = eventCode ?? String(eventId);
  const dateLabel = date ?? "event";
  return `${codeOrId} ${dateLabel} ${period ?? ""}`.trim();
}

async function presignS3Url(parts: S3UrlParts): Promise<string> {
  const client = new S3Client({
    region: parts.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });
  const command = new GetObjectCommand({ Bucket: parts.bucket, Key: parts.key });
  return getSignedUrl(client, command, { expiresIn: 6 * 60 * 60 });
}

interface CliArgs {
  eventId: number;
  inputPath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let eventId: number | null = null;
  let inputPath: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--event") eventId = Number(argv[++i]);
    else if (arg === "--input") inputPath = argv[++i] ?? null;
    else if (arg === "--dry-run") dryRun = true;
  }
  if (!eventId || Number.isNaN(eventId) || !inputPath) {
    throw new Error(
      "Usage: bun src/scripts/import-s3-videos.ts --event <eventId> --input <mapping.json> [--dry-run]",
    );
  }
  return { eventId, inputPath, dryRun };
}

interface PlanRow {
  url: string;
  sessionId: number;
  date: string | null;
  period: string | null;
  position: number;
}

async function main(): Promise<void> {
  const { eventId, inputPath, dryRun } = parseArgs(process.argv.slice(2));

  const event = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!event) throw new Error(`Event ${eventId} not found`);

  const raw = await readFile(inputPath, "utf-8");
  const mapping = JSON.parse(raw) as MappingEntry[];

  console.log(
    `Resolving ${mapping.length} entr${mapping.length === 1 ? "y" : "ies"} for event ${eventId} (${event.eventCode})…`,
  );

  const planRows: PlanRow[] = [];
  const unresolved: ResolvedEntry[] = [];

  console.log("\nResolution:");
  for (const entry of mapping) {
    const resolved = await resolveEntry(entry, eventId);
    if (!resolved.session) {
      unresolved.push(resolved);
      console.log(`  UNRESOLVED ${entry.url} — ${resolved.reason}`);
      continue;
    }
    const position = await nextPosition(eventId);
    planRows.push({
      url: entry.url,
      sessionId: resolved.session.id,
      date: resolved.date,
      period: resolved.period,
      position,
    });
    console.log(
      `  ${entry.url} → { sessionId: ${resolved.session.id}, date: ${resolved.date}, period: ${
        resolved.period ?? "null"
      }, position: ${position} }`,
    );
  }

  if (dryRun) {
    console.log(
      `\n--dry-run: ${planRows.length} would be imported, ${unresolved.length} unresolved. No changes made.`,
    );
    return;
  }

  let created = 0;
  for (const row of planRows) {
    const parts = parseS3Url(row.url);
    if (!parts) {
      console.warn(`  SKIP (not a parseable S3 url): ${row.url}`);
      continue;
    }
    const presignedUrl = await presignS3Url(parts);
    const title = buildTitle(event.eventCode, eventId, row.date, row.period);
    console.log(`\nPulling "${row.url}" into Bunny as "${title}"…`);
    const { guid } = await fetchVideo(presignedUrl, title);

    await db.insert(eventVideos).values({
      eventId,
      bunnyVideoId: guid,
      position: row.position,
      titleEn: row.period ? capitalize(row.period) : null,
      videoDate: row.date,
    });
    console.log(`  OK: guid=${guid} → event_videos row (eventId=${eventId}, position=${row.position}, session=${row.sessionId})`);
    created++;
  }

  console.log(`\nDone: ${created} video(s) imported. ${unresolved.length} unresolved.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
