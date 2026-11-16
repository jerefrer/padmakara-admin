/**
 * Which Easypay captures of a subscription have been paid and not yet credited.
 *
 * Pure functions, shared by the webhook, the reconcile job and the read-only dry run
 * (`src/scripts/membership-capture-dry-run.ts`), so all three agree on what counts.
 *
 * Source of truth: `GET /2.0/subscription/{id}` carries a `transactions` array, one entry
 * per capture, each with its own uuid `id`, a `date`, a `created_at` and `values.paid`
 * (documented at docs.easypay.pt, and present in every raw_subscription stored after a
 * successful capture in production). Entries carry no status. After a failed capture,
 * and after subscription_create, the key is absent altogether.
 *
 * Fail-safe rules, for what neither the documentation nor production data settles:
 *  - an entry is paid only when `values.paid` is a positive number that covers
 *    `values.requested` (when given): a failed or partial capture listed with 0 or less
 *    than asked never extends access;
 *  - an entry without a uuid id is skipped, since it could not be credited only once;
 *  - a capture credited before this logic existed (a "legacy" credit, `action`
 *    activated/extended with no `easypay_transaction_id`) is recognised two ways, and
 *    either is enough: its id is listed in the `raw_subscription` stored on a legacy
 *    row of the same subscription, or it happened no later than the newest legacy
 *    credit of that subscription. The second rule covers a capture that Easypay had not
 *    yet listed when its notification was processed; its cost is that a capture the old
 *    code missed before its last credit is never credited automatically (the dry run
 *    lists such captures for a human).
 */
import { addInterval, type MembershipInterval } from "./membership.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ledger actions that extended a membership. */
export const CREDIT_ACTIONS = ["activated", "extended"];

export interface EasypayCapture {
  id: string;
  /** Epoch ms of the capture: the earlier of `date` and `created_at`; null when neither parses. */
  at: number | null;
  paid: number | null;
  requested: number | null;
  method: string | null;
}

/** Easypay timestamps ("2026-10-07 14:06:15" with no zone, or "2026-10-07T14:06:15Z") as epoch ms. */
export function easypayTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const iso = value.trim().replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The well-formed entries of `subscription.transactions`; an absent or malformed array is empty. */
export function listCaptures(subscription: unknown): EasypayCapture[] {
  const list = asRecord(subscription)?.transactions;
  if (!Array.isArray(list)) return [];
  const out: EasypayCapture[] = [];
  for (const raw of list) {
    const t = asRecord(raw);
    if (!t || typeof t.id !== "string" || !UUID.test(t.id)) continue;
    const values = asRecord(t.values);
    const times = [easypayTime(t.date), easypayTime(t.created_at)].filter((x): x is number => x !== null);
    out.push({
      id: t.id.toLowerCase(),
      at: times.length ? Math.min(...times) : null,
      paid: asNumber(values?.paid),
      requested: asNumber(values?.requested),
      method: typeof t.method === "string" ? t.method : null,
    });
  }
  return out;
}

const cents = (v: number) => Math.round(v * 100);

/** Paid in full: a positive `values.paid` that covers `values.requested` when Easypay gives it. */
export function isPaidCapture(c: EasypayCapture): boolean {
  if (c.paid === null || cents(c.paid) <= 0) return false;
  return c.requested === null || cents(c.paid) >= cents(c.requested);
}

/** The ledger columns these rules read. */
export interface LedgerCreditRow {
  action: string;
  easypayTransactionId: string | null;
  createdAt: Date | string;
  rawSubscription: unknown;
}

const isLegacyCredit = (r: LedgerCreditRow) => CREDIT_ACTIONS.includes(r.action) && !r.easypayTransactionId;

/**
 * What the ledger rows of ONE subscription already account for: the capture ids credited
 * (new rows) or listed on a legacy credit, and the time of the newest legacy credit.
 */
export function countedCaptures(rows: LedgerCreditRow[]): { ids: Set<string>; legacyCutoff: number | null } {
  const ids = new Set<string>();
  let legacyCutoff: number | null = null;
  for (const r of rows) {
    if (r.easypayTransactionId) ids.add(r.easypayTransactionId.toLowerCase());
    if (!isLegacyCredit(r)) continue;
    for (const c of listCaptures(r.rawSubscription)) ids.add(c.id);
    const at = new Date(r.createdAt).getTime();
    if (!Number.isNaN(at) && (legacyCutoff === null || at > legacyCutoff)) legacyCutoff = at;
  }
  return { ids, legacyCutoff };
}

/**
 * The captures of `subscription` that are paid and not yet counted, oldest first.
 * `rows` must be the ledger rows of that subscription (its id as `notification_id`).
 */
export function uncountedPaidCaptures(subscription: unknown, rows: LedgerCreditRow[]): EasypayCapture[] {
  const { ids, legacyCutoff } = countedCaptures(rows);
  return listCaptures(subscription)
    .filter((c) => isPaidCapture(c) && !ids.has(c.id))
    // A capture with no readable time cannot be placed after the last legacy credit, so
    // where legacy credits exist it is treated as counted rather than risk a second credit.
    .filter((c) => legacyCutoff === null || (c.at !== null && c.at > legacyCutoff))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * The paid-through date after crediting one capture: one interval from the later of the
 * current paid-through date and the capture time (never later than `now`). A renewal paid
 * early does not shorten the period already paid; one paid late does not swallow the days
 * it was late; one credited late (reconcile) counts from when it was paid.
 */
export function expiryAfterCapture(
  current: Date | null,
  interval: MembershipInterval,
  captureAt: number | null,
  now: Date = new Date(),
): Date {
  const paidAt = captureAt === null ? now.getTime() : Math.min(captureAt, now.getTime());
  const base = current && current.getTime() > paidAt ? current : new Date(paidAt);
  return addInterval(base, interval);
}
