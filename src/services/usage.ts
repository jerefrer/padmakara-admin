import { eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { usageDaily, userActiveDays } from "../db/schema/usage.ts";
import { eventVideos } from "../db/schema/event-videos.ts";

/**
 * Server-side usage counting. Everything here is fire-and-forget: a failure is
 * logged and never reaches (or slows) the request that triggered it.
 *
 * Privacy: usage_daily holds totals with no user column. user_active_days is
 * the only per-user usage data, kept ACTIVE_DAYS_RETENTION_MONTHS months.
 */

export type UsageMetric =
  | "transcript_open"
  | "file_open"
  | "readalong_open"
  | "video_start"
  | "video_download"
  | "zip_download"
  | "app_open";

export const ACTIVE_DAYS_RETENTION_MONTHS = 13;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const APP_OPEN_WINDOW_MS = 60 * 60 * 1000;

const lisbonFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in Europe/Lisbon. */
export function lisbonDay(now: Date = new Date()): string {
  return lisbonFormat.format(now);
}

/** Add one to today's counter for a metric (event id 0 = not tied to an event). */
export function countUsage(metric: UsageMetric, eventId: number = 0): void {
  void (async () => {
    try {
      await db
        .insert(usageDaily)
        .values({ day: lisbonDay(), metric, eventId, count: 1 })
        .onConflictDoUpdate({
          target: [usageDaily.day, usageDaily.metric, usageDaily.eventId],
          set: { count: sql`${usageDaily.count} + 1` },
        });
    } catch (err) {
      console.error("usage count failed", metric, err);
    }
  })();
}

// "userId:day" keys already written, so a busy account costs one write a day.
let activeSeen = new Set<string>();
let activeSeenDay = "";

/** Record that this account was active today (one write per account per day). */
export function markActive(userId: number): void {
  const day = lisbonDay();
  if (day !== activeSeenDay) {
    activeSeen = new Set();
    activeSeenDay = day;
  }
  const key = `${userId}`;
  if (activeSeen.has(key)) return;
  activeSeen.add(key);
  void (async () => {
    try {
      await db.insert(userActiveDays).values({ userId, day }).onConflictDoNothing();
    } catch (err) {
      // Allow a retry on the next request
      activeSeen.delete(key);
      console.error("usage markActive failed", err);
    }
  })();
}

const lastAppOpen = new Map<number, number>();

/** Count an app launch/foreground, at most once per user per hour. */
export function countAppOpen(userId: number, nowMs: number = Date.now()): void {
  const last = lastAppOpen.get(userId);
  if (last !== undefined && nowMs - last < APP_OPEN_WINDOW_MS) return;
  lastAppOpen.set(userId, nowMs);
  countUsage("app_open");
}

/** Count a video start against the event that owns the video. */
export function countVideoStart(videoId: number): void {
  void (async () => {
    try {
      const [row] = await db
        .select({ eventId: eventVideos.eventId })
        .from(eventVideos)
        .where(eq(eventVideos.id, videoId))
        .limit(1);
      if (row?.eventId != null) countUsage("video_start", row.eventId);
    } catch (err) {
      console.error("usage video_start lookup failed", err);
    }
  })();
}

/**
 * True for a request that starts a file (no Range header, or a range from byte
 * 0), so one open counts once even when the client fetches it in chunks.
 */
export function isFirstChunkRequest(rangeHeader: string | undefined | null): boolean {
  if (!rangeHeader) return true;
  const m = /^bytes=(\d*)-/i.exec(rangeHeader.trim());
  return !!m && (m[1] === "" || Number(m[1]) === 0);
}

/** Delete daily activity older than the retention window. */
export async function pruneUsage(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ACTIVE_DAYS_RETENTION_MONTHS);
  await db.delete(userActiveDays).where(lt(userActiveDays.day, lisbonDay(cutoff)));
}

/** Prune now, then every 24 h. The timer never keeps the process alive. */
export function startUsagePruning(): void {
  const run = () =>
    pruneUsage().catch((err) => console.error("usage prune failed", err));
  void run();
  setInterval(run, PRUNE_INTERVAL_MS).unref();
}

/** Test hook. */
export function resetUsageStateForTests(): void {
  activeSeen = new Set();
  activeSeenDay = "";
  lastAppOpen.clear();
}
