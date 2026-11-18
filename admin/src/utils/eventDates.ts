const pad = (n: number): string => String(n).padStart(2, "0");

/** Year, month and day of a "YYYY-MM-DD" (or full ISO) date string, read as written, without time zones. */
function parts(date: string): { y: string; m: string; d: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return match ? { y: match[1]!, m: match[2]!, d: match[3]! } : null;
}

/** "18–20/09/2026", "18/09–02/10/2026", "18/09/2025–02/01/2026" or one date when the days match. "—" when no start. */
export function formatEventDates(startDate?: string | null, endDate?: string | null): string {
  const start = startDate ? parts(startDate) : null;
  if (!start) return "—";
  const end = endDate ? parts(endDate) : null;
  if (!end || (end.y === start.y && end.m === start.m && end.d === start.d)) {
    return `${start.d}/${start.m}/${start.y}`;
  }
  if (end.y === start.y && end.m === start.m) return `${start.d}–${end.d}/${end.m}/${end.y}`;
  if (end.y === start.y) return `${start.d}/${start.m}–${end.d}/${end.m}/${end.y}`;
  return `${start.d}/${start.m}/${start.y}–${end.d}/${end.m}/${end.y}`;
}

/** dd/mm/yyyy of a timestamp in the viewer's time zone, "—" when missing or invalid. */
export function formatDayMonthYear(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}
