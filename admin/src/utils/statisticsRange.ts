export const STATISTICS_RANGES = [7, 30, 90, 365] as const;
export type StatisticsRange = (typeof STATISTICS_RANGES)[number];

function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The last `days` days, ending today, as YYYY-MM-DD strings. */
export function rangeFor(days: number, today: Date = new Date()): { from: string; to: string } {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: ymd(start), to: ymd(today) };
}
