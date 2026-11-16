/**
 * READ-ONLY DRY RUN — makes no write to the database and no call to Easypay.
 *
 *   DATABASE_URL=postgres://… bun run src/scripts/membership-capture-dry-run.ts
 *
 * Runs every query inside a `BEGIN READ ONLY` transaction (Postgres refuses any write in
 * it) and rolls it back. Prints user ids and figures only: no name, email or phone.
 *
 * What it answers, before the capture-based crediting (2026-11-16) is deployed:
 *  1. Per member with an Easypay subscription: the current `subscription_expires_at`, the
 *     paid-through date the new rules compute by replaying every paid capture found in
 *     the stored `raw_subscription` snapshots, and the difference in days. A member whose
 *     date would move by more than a day is flagged: the stored history does not explain
 *     their date (old double credit, forged notification, admin edit, missed capture).
 *  2. "next": how many stored captures the new code would credit at that member's next
 *     notification. It must be 0 for everyone, or deploying gives free months.
 *  3. "lag": legacy credits whose own snapshot does not list a capture made in the hour
 *     before them. If that count is not 0, Easypay notified before listing the capture,
 *     and only the time cutoff (not the snapshot ids) keeps those captures from being
 *     credited a second time.
 *
 * The rules come from `src/services/membership-captures.ts`, the same code the webhook
 * and the reconcile job run.
 */
import postgres from "postgres";
import {
  CREDIT_ACTIONS,
  expiryAfterCapture,
  isPaidCapture,
  listCaptures,
  uncountedPaidCaptures,
  type EasypayCapture,
} from "../services/membership-captures.ts";
import { intervalFromFrequency } from "../services/membership.ts";

export interface LedgerRow {
  id: number;
  userId: number | null;
  notificationId: string;
  action: string;
  easypayTransactionId: string | null;
  rawSubscription: unknown;
  createdAt: Date;
}

export interface MemberRow {
  id: number;
  subscriptionSource: string | null;
  subscriptionStatus: string;
  easypaySubscriptionId: string | null;
  subscriptionExpiresAt: Date | null;
}

export interface MemberReport {
  userId: number;
  source: string | null;
  current: Date | null;
  replayed: Date | null;
  diffDays: number | null;
  credits: number;
  paidCaptures: number;
  next: number;
  lag: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const frequencyOf = (snapshot: unknown): string | null => {
  const f = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>).frequency : null;
  return typeof f === "string" ? f : null;
};

/** Replays one member's stored history with the new rules. `rows` are that member's ledger rows. */
export function replayMember(member: MemberRow, rows: LedgerRow[]): MemberReport {
  const bySubscription = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = r.notificationId.toLowerCase();
    bySubscription.set(key, [...(bySubscription.get(key) ?? []), r]);
  }

  // Every paid capture any snapshot lists, once, with the interval of its subscription.
  const captures = new Map<string, { capture: EasypayCapture; frequency: string | null }>();
  let next = 0;
  for (const subRows of bySubscription.values()) {
    const sorted = [...subRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const snapshots = sorted.filter((r) => r.rawSubscription && typeof r.rawSubscription === "object");
    const latest = snapshots.at(-1)?.rawSubscription ?? null;
    for (const r of snapshots) {
      for (const c of listCaptures(r.rawSubscription)) {
        if (isPaidCapture(c)) captures.set(c.id, { capture: c, frequency: frequencyOf(r.rawSubscription) });
      }
    }
    // What the new code would credit if Easypay answered with the newest stored snapshot.
    if (latest) next += uncountedPaidCaptures(latest, subRows).length;
  }

  let replayed: Date | null = null;
  for (const { capture, frequency } of [...captures.values()].sort((a, b) => (a.capture.at ?? 0) - (b.capture.at ?? 0))) {
    const at = capture.at ?? Date.now();
    replayed = expiryAfterCapture(replayed, intervalFromFrequency(frequency), at, new Date(at));
  }

  const credits = rows.filter((r) => CREDIT_ACTIONS.includes(r.action));
  const lag = credits.filter((r) => {
    if (r.easypayTransactionId) return false;
    const created = r.createdAt.getTime();
    return !listCaptures(r.rawSubscription).some((c) => c.at !== null && c.at <= created && c.at >= created - HOUR_MS);
  }).length;

  const current = member.subscriptionExpiresAt;
  return {
    userId: member.id,
    source: member.subscriptionSource,
    current,
    replayed,
    diffDays: current && replayed ? (replayed.getTime() - current.getTime()) / DAY_MS : null,
    credits: credits.length,
    paidCaptures: captures.size,
    next,
    lag,
  };
}

/** Thrown to leave the read-only transaction by rollback once everything is read. */
class RollbackAfterRead extends Error {}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "-");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const members: MemberRow[] = [];
  const ledger: LedgerRow[] = [];
  try {
    await client.begin("read only", async (sql) => {
      const userRows = await sql<
        { id: number; subscription_source: string | null; subscription_status: string; easypay_subscription_id: string | null; subscription_expires_at: Date | null }[]
      >`
        SELECT id, subscription_source, subscription_status, easypay_subscription_id, subscription_expires_at
        FROM users
        WHERE easypay_subscription_id IS NOT NULL
           OR id IN (SELECT user_id FROM payment_transactions WHERE user_id IS NOT NULL AND action IN ('activated', 'extended'))
        ORDER BY id`;
      for (const u of userRows) {
        members.push({
          id: u.id,
          subscriptionSource: u.subscription_source,
          subscriptionStatus: u.subscription_status,
          easypaySubscriptionId: u.easypay_subscription_id,
          subscriptionExpiresAt: u.subscription_expires_at,
        });
      }
      // easypay_transaction_id does not exist before migration 0070: read it only if it does.
      const [{ has_column }] = await sql<{ has_column: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payment_transactions' AND column_name = 'easypay_transaction_id'
        ) AS has_column`;
      const rows = has_column
        ? await sql<{ id: number; user_id: number | null; notification_id: string; action: string; easypay_transaction_id: string | null; raw_subscription: unknown; created_at: Date }[]>`
            SELECT id, user_id, notification_id, action, easypay_transaction_id, raw_subscription, created_at
            FROM payment_transactions ORDER BY id`
        : await sql<{ id: number; user_id: number | null; notification_id: string; action: string; easypay_transaction_id: null; raw_subscription: unknown; created_at: Date }[]>`
            SELECT id, user_id, notification_id, action, NULL::text AS easypay_transaction_id, raw_subscription, created_at
            FROM payment_transactions ORDER BY id`;
      for (const r of rows) {
        ledger.push({
          id: r.id,
          userId: r.user_id,
          notificationId: r.notification_id,
          action: r.action,
          easypayTransactionId: r.easypay_transaction_id,
          rawSubscription: r.raw_subscription,
          createdAt: new Date(r.created_at),
        });
      }
      // Nothing to keep: end the read-only transaction without committing anything.
      throw new RollbackAfterRead();
    });
  } catch (err) {
    if (!(err instanceof RollbackAfterRead)) throw err;
  } finally {
    await client.end();
  }

  console.log("READ-ONLY dry run of capture-based crediting — no writes, no Easypay calls.\n");
  console.log("user   source         current            replayed           diff(d)  credits paid  next  lag  flag");
  let flagged = 0;
  let nextTotal = 0;
  let lagTotal = 0;
  for (const m of members) {
    const report = replayMember(m, ledger.filter((r) => r.userId === m.id));
    const moved = report.diffDays !== null && Math.abs(report.diffDays) > 1;
    const unexplained = report.diffDays === null && (report.current !== null) !== (report.replayed !== null);
    const flag = [
      moved ? "DATE-WOULD-MOVE" : "",
      unexplained ? "NO-HISTORY" : "",
      report.next > 0 ? "WOULD-RECREDIT" : "",
      report.credits !== report.paidCaptures ? "CREDITS!=CAPTURES" : "",
    ].filter(Boolean).join(",");
    if (flag) flagged++;
    nextTotal += report.next;
    lagTotal += report.lag;
    console.log(
      [
        String(report.userId).padEnd(6),
        String(report.source ?? "-").padEnd(14),
        day(report.current).padEnd(18),
        day(report.replayed).padEnd(18),
        (report.diffDays === null ? "-" : report.diffDays.toFixed(1)).padStart(7),
        String(report.credits).padStart(7),
        String(report.paidCaptures).padStart(5),
        String(report.next).padStart(5),
        String(report.lag).padStart(4),
        flag,
      ].join(" "),
    );
  }

  const detached = ledger.filter((r) => r.userId === null);
  const ownerOf = new Map<string, Set<number | null>>();
  for (const r of ledger) {
    for (const c of listCaptures(r.rawSubscription)) {
      ownerOf.set(c.id, new Set([...(ownerOf.get(c.id) ?? []), r.userId]));
    }
  }
  const shared = [...ownerOf.values()].filter((owners) => owners.size > 1).length;

  console.log("\nSummary");
  console.log(`  members listed:                         ${members.length}`);
  console.log(`  members flagged:                        ${flagged}`);
  console.log(`  captures the new code would re-credit:  ${nextTotal}   (must be 0 before deploying)`);
  console.log(`  legacy credits missing their capture:   ${lagTotal}   (0 = Easypay lists the capture when it notifies)`);
  console.log(`  ledger rows of deleted accounts:        ${detached.length}   (skipped; their captures cannot be credited again: no user)`);
  console.log(`  captures listed under several users:    ${shared}   (should be 0)`);
  console.log("\nFlags: DATE-WOULD-MOVE = stored captures replayed give a date more than a day away from the current one;");
  console.log("NO-HISTORY = a date with no paid capture behind it, or the reverse; WOULD-RECREDIT = see above;");
  console.log("CREDITS!=CAPTURES = the old code credited a different number of times than there are paid captures.");
  console.log("A flag is for a human to look at; this script changes nothing.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
