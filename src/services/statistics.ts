import { and, count, countDistinct, desc, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { lisbonDay } from "./usage.ts";
import { users } from "../db/schema/users.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { userProgress } from "../db/schema/user-content.ts";
import { videoProgress } from "../db/schema/video-progress.ts";
import { deviceActivations } from "../db/schema/auth.ts";
import { teachingOrders } from "../db/schema/event-access.ts";
import { paymentTransactions } from "../db/schema/payment-transactions.ts";
import { usageDaily, userActiveDays } from "../db/schema/usage.ts";

/**
 * Aggregate statistics for the admin Statistics page.
 *
 * Privacy: every figure here is a total. Nothing returned identifies a person:
 * no user id, name or email, and no per-person usage view.
 */

const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;
const TOP_EVENTS = 20;
const PLATFORM_WINDOW_DAYS = 90;
const LISBON = "Europe/Lisbon";

export interface DateRange {
  from: string;
  to: string;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Validate ?from/?to (YYYY-MM-DD, Lisbon days); default is the last 30 days ending today. */
export function resolveRange(
  fromQ: string | undefined,
  toQ: string | undefined,
  now: Date = new Date(),
): DateRange {
  const today = lisbonDay(now);
  const to = toQ ?? today;
  const from = fromQ ?? shiftDay(to, -29);
  if (!isRealDate(from) || !isRealDate(to)) {
    throw AppError.badRequest("from and to must be dates as YYYY-MM-DD", "VALIDATION_ERROR");
  }
  if (from > to) {
    throw AppError.badRequest("from must not be after to", "VALIDATION_ERROR");
  }
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > MAX_RANGE_DAYS) {
    throw AppError.badRequest(`The range is limited to ${MAX_RANGE_DAYS} days`, "VALIDATION_ERROR");
  }
  return { from, to };
}

/** "YYYY-MM" for the last 12 months (Lisbon), oldest first, ending with the current month. */
export function lastTwelveMonths(now: Date = new Date()): string[] {
  const [y, m] = lisbonDay(now).split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

const lisbonDate = (col: unknown) => sql`((${col}) AT TIME ZONE ${LISBON})::date`;
const monthOf = (col: unknown) => sql<string>`to_char(${lisbonDate(col)}, 'YYYY-MM')`;
const num = (v: unknown) => Number(v ?? 0);

export async function getStatistics(range: DateRange, now: Date = new Date()) {
  const today = lisbonDay(now);
  const months = lastTwelveMonths(now);
  const monthsStart = `${months[0]}-01`;
  const inRange = (col: unknown) =>
    and(sql`${lisbonDate(col)} >= ${range.from}::date`, sql`${lisbonDate(col)} <= ${range.to}::date`);

  // Active membership, as in hasActiveSubscription(): status active and not past expiry + grace.
  const activeMember = and(
    eq(users.subscriptionStatus, "active"),
    sql`(${users.subscriptionExpiresAt} IS NULL OR ${users.subscriptionExpiresAt} + (${config.subscription.graceDays} * interval '1 day') >= now())`,
  );

  const distinctActive = (from: string, to: string) =>
    db
      .select({ n: countDistinct(userActiveDays.userId) })
      .from(userActiveDays)
      .where(and(gte(userActiveDays.day, from), lte(userActiveDays.day, to)));

  const [
    totalRows,
    newRows,
    memberRows,
    last7Rows,
    last30Rows,
    rangeRows,
    signupRows,
    activeMonthRows,
    salesRows,
    membershipRows,
    platformRows,
    openRows,
    eventRows,
  ] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(users).where(inRange(users.createdAt)),
    db.select({ n: count() }).from(users).where(activeMember),
    distinctActive(shiftDay(today, -6), today),
    distinctActive(shiftDay(today, -29), today),
    distinctActive(range.from, range.to),
    db
      .select({ month: monthOf(users.createdAt), n: count() })
      .from(users)
      .where(sql`${lisbonDate(users.createdAt)} >= ${monthsStart}::date`)
      .groupBy(sql`1`),
    db
      .select({
        month: sql<string>`to_char(${userActiveDays.day}, 'YYYY-MM')`,
        n: countDistinct(userActiveDays.userId),
      })
      .from(userActiveDays)
      .where(gte(userActiveDays.day, monthsStart))
      .groupBy(sql`to_char(${userActiveDays.day}, 'YYYY-MM')`),
    db
      .select({ month: monthOf(teachingOrders.paidAt), cents: sum(teachingOrders.amountCents) })
      .from(teachingOrders)
      .where(
        and(
          eq(teachingOrders.status, "paid"),
          sql`${teachingOrders.paidAt} IS NOT NULL`,
          sql`${lisbonDate(teachingOrders.paidAt)} >= ${monthsStart}::date`,
        ),
      )
      .groupBy(sql`1`),
    // A membership payment that was captured: the webhook records it as activated or extended.
    db
      .select({ month: monthOf(paymentTransactions.createdAt), amount: sum(paymentTransactions.amount) })
      .from(paymentTransactions)
      .where(
        and(
          inArray(paymentTransactions.action, ["activated", "extended"]),
          sql`${lisbonDate(paymentTransactions.createdAt)} >= ${monthsStart}::date`,
        ),
      )
      .groupBy(sql`1`),
    db
      .select({ deviceType: deviceActivations.deviceType, n: count() })
      .from(deviceActivations)
      .where(
        sql`(${deviceActivations.lastUsed} >= now() - (${PLATFORM_WINDOW_DAYS} * interval '1 day') OR ${deviceActivations.activatedAt} >= now() - (${PLATFORM_WINDOW_DAYS} * interval '1 day'))`,
      )
      .groupBy(deviceActivations.deviceType)
      .orderBy(desc(count())),
    db
      .select({ day: usageDaily.day, n: sum(usageDaily.count) })
      .from(usageDaily)
      .where(and(eq(usageDaily.metric, "app_open"), gte(usageDaily.day, range.from), lte(usageDaily.day, range.to)))
      .groupBy(usageDaily.day)
      .orderBy(usageDaily.day),
    // Listening comes from user_progress (audio is played offline and in ranges, so not counted from requests).
    db
      .select({
        id: events.id,
        titleEn: events.titleEn,
        titlePt: events.titlePt,
        listeners: countDistinct(userProgress.userId),
        completedTracks: sql<number>`count(*) filter (where ${userProgress.isCompleted})`,
        listenSeconds: sum(userProgress.totalListenSeconds),
      })
      .from(userProgress)
      .innerJoin(tracks, eq(tracks.id, userProgress.trackId))
      .innerJoin(sessions, eq(sessions.id, tracks.sessionId))
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(and(eq(events.status, "published"), inRange(userProgress.lastPlayed)))
      .groupBy(events.id, events.titleEn, events.titlePt)
      .orderBy(desc(countDistinct(userProgress.userId)), events.id)
      .limit(TOP_EVENTS),
  ]);

  const eventIds = eventRows.map((r) => r.id);
  let videoRows: { eventId: number; n: number }[] = [];
  let usageRows: { eventId: number; metric: string; n: unknown }[] = [];
  if (eventIds.length > 0) {
    [videoRows, usageRows] = await Promise.all([
      db
        .select({ eventId: eventVideos.eventId, n: countDistinct(videoProgress.userId) })
        .from(videoProgress)
        .innerJoin(eventVideos, eq(eventVideos.id, videoProgress.videoId))
        .where(and(inArray(eventVideos.eventId, eventIds), inRange(videoProgress.updatedAt)))
        .groupBy(eventVideos.eventId),
      db
        .select({ eventId: usageDaily.eventId, metric: usageDaily.metric, n: sum(usageDaily.count) })
        .from(usageDaily)
        .where(
          and(inArray(usageDaily.eventId, eventIds), gte(usageDaily.day, range.from), lte(usageDaily.day, range.to)),
        )
        .groupBy(usageDaily.eventId, usageDaily.metric),
    ]);
  }

  const byMonth = <T extends { month: string }>(rows: T[]) => new Map(rows.map((r) => [r.month, r]));
  const signups = byMonth(signupRows);
  const active = byMonth(activeMonthRows);
  const sales = byMonth(salesRows);
  const membership = byMonth(membershipRows);

  const usage = (eventId: number, metric: string) =>
    num(usageRows.find((r) => r.eventId === eventId && r.metric === metric)?.n);

  return {
    range,
    accounts: {
      total: num(totalRows[0]?.n),
      newInRange: num(newRows[0]?.n),
      activeMembers: num(memberRows[0]?.n),
    },
    activeUsers: {
      last7: num(last7Rows[0]?.n),
      last30: num(last30Rows[0]?.n),
      inRange: num(rangeRows[0]?.n),
    },
    monthly: months.map((month) => ({
      month,
      signups: num(signups.get(month)?.n),
      activeUsers: num(active.get(month)?.n),
      teachingSalesCents: num(sales.get(month)?.cents),
      membershipCents: Math.round(num(membership.get(month)?.amount) * 100),
    })),
    platforms: platformRows.map((r) => ({ deviceType: r.deviceType, count: num(r.n) })),
    events: eventRows.map((r) => ({
      id: r.id,
      title: r.titleEn,
      titlePt: r.titlePt,
      listeners: num(r.listeners),
      completedTracks: num(r.completedTracks),
      listenHours: Math.round((num(r.listenSeconds) / 3600) * 10) / 10,
      videoViewers: num(videoRows.find((v) => v.eventId === r.id)?.n),
      transcriptOpens: usage(r.id, "transcript_open"),
      fileOpens: usage(r.id, "file_open"),
      videoStarts: usage(r.id, "video_start"),
      zipDownloads: usage(r.id, "zip_download"),
    })),
    appOpens: openRows.map((r) => ({ day: r.day, count: num(r.n) })),
  };
}
