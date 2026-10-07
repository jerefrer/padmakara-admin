/**
 * Pure membership rules shared by the payment routes: contribution bounds, Easypay
 * frequency mapping and access-period arithmetic. See the design doc D1–D5.
 */
export type MembershipInterval = "month" | "year";

export const MIN_AMOUNT: Record<MembershipInterval, number> = { month: 5, year: 60 };
export const MAX_AMOUNT = 1000;

export function parseContribution(
  amount: unknown,
  interval: unknown,
): { ok: true; amount: number; interval: MembershipInterval } | { ok: false; error: string } {
  if (interval !== "month" && interval !== "year") {
    return { ok: false, error: "Interval must be month or year" };
  }
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "Amount must be a number" };
  }
  if (Math.round(value * 100) !== value * 100) {
    return { ok: false, error: "Amount can have at most two decimals" };
  }
  const min = MIN_AMOUNT[interval];
  if (value < min) return { ok: false, error: `Minimum contribution is €${min}` };
  if (value > MAX_AMOUNT) return { ok: false, error: `Maximum contribution is €${MAX_AMOUNT}` };
  return { ok: true, amount: value, interval };
}

export function frequencyFor(interval: MembershipInterval): "1M" | "1Y" {
  return interval === "year" ? "1Y" : "1M";
}

export function intervalFromFrequency(frequency: string | undefined | null): MembershipInterval {
  return frequency === "1Y" ? "year" : "month";
}

export function addInterval(date: Date, interval: MembershipInterval): Date {
  const d = new Date(date);
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * Extend from the later of now and the current paid-through date: an early renewal
 * must not shorten the paid period, a late one must not swallow the days it was late.
 */
export function nextExpiry(current: Date | null, interval: MembershipInterval, now = new Date()): Date {
  const base = current && current > now ? current : now;
  return addInterval(base, interval);
}

export function easypayDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16);
}
