/** "10–11 Oct 2026", "30 Sep – 2 Oct 2026", "10 Oct 2026"; "" when there is no valid start date. */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

function parse(iso: string | null | undefined): Date | null {
  const m = iso?.match(ISO_DAY);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDateRange(start: string | null | undefined, end: string | null | undefined, locale: string): string {
  const from = parse(start);
  if (!from) return "";
  const lang = locale === "pt" ? "pt-PT" : "en-GB";
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...opts }).format(d).replace(/\./g, "");
  const to = parse(end);
  if (!to || to.getTime() === from.getTime()) {
    return fmt(from, { day: "numeric", month: "short", year: "numeric" });
  }
  if (from.getUTCFullYear() === to.getUTCFullYear() && from.getUTCMonth() === to.getUTCMonth()) {
    const month = fmt(to, { month: "short", year: "numeric" });
    return `${from.getUTCDate()}–${to.getUTCDate()} ${month}`;
  }
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return `${fmt(from, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`;
}
