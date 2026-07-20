/**
 * Date and period parsing for session markers in track filenames.
 *
 * Shared by track-parser.ts (which reads markers anchored by a period word)
 * and session-ranges.ts (which reads bare dates on range-defining files).
 */

// A track filename may carry the session it belongs to as a trailing marker,
// usually parenthesized, e.g. "(11 June PM)". The date part comes in several
// shapes and both English/Portuguese; the day may precede or follow the month,
// may carry an ordinal suffix, or be fully numeric (day-first, Portuguese
// convention) with an optional year. All resolve to the same normalized form.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_NORMALIZE: Record<string, string> = {
  january: "January", february: "February", march: "March", april: "April",
  may: "May", june: "June", july: "July", august: "August",
  september: "September", october: "October", november: "November", december: "December",
  janeiro: "January", fevereiro: "February", março: "March", abril: "April",
  maio: "May", junho: "June", julho: "July", agosto: "August",
  setembro: "September", outubro: "October", novembro: "November", dezembro: "December",
};

// Month names (English + Portuguese) for the session-marker regexes.
const MONTHS_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December"
  + "|Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro";

// A self-contained date token: numeric DD/MM[/YYYY], day-then-month, or
// month-then-day — each with an optional ordinal suffix on the day. Captured as
// a single group and re-parsed by parseSessionDateToken so group numbering
// stays stable across the alternatives.
//
// Separators now include "_": the older Portuguese-labelled recordings write
// the day as "6_10" (6 October) rather than "6/10".
export const SESSION_DATE_TOKEN =
  `(?:\\d{1,2}[/_-]\\d{1,2}(?:[/_-]\\d{2,4})?`
  + `|\\d{1,2}(?:st|nd|rd|th)?[\\s_-]+(?:${MONTHS_PATTERN})`
  + `|(?:${MONTHS_PATTERN})[\\s_-]+\\d{1,2}(?:st|nd|rd|th)?)`;

// Session period words, English and Portuguese.
export const PERIOD_WORDS = "AM|PM|Manha|Manhã|Morning|Tarde|Afternoon|Noite|Evening";

const PERIOD_MAP: Record<string, string> = {
  am: "morning", manha: "morning", "manhã": "morning", morning: "morning",
  pm: "afternoon", tarde: "afternoon", afternoon: "afternoon",
  noite: "evening", evening: "evening",
};

export function normalizePeriod(word: string): string | null {
  return PERIOD_MAP[word.toLowerCase()] ?? null;
}

/** Expand a 2- or 4-digit year string to a full year (2-digit ≥70 → 19xx). */
function normalizeYear(y: string): number {
  const n = parseInt(y, 10);
  if (y.length <= 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

/**
 * Parse a bare date token (already stripped of the AM/PM and part suffix) into
 * a month name, day, and optional year. Returns null if the token is not a
 * recognizable date, so a false-positive parenthetical is simply ignored.
 */
export function parseSessionDateToken(
  token: string,
): { month: string; day: number; year: number | null } | null {
  const t = token.trim();

  // Numeric day-first: 11/06, 11-06, 11_06, 11/06/2026, 11-06-2026
  const numeric = t.match(/^(\d{1,2})[/_-](\d{1,2})(?:[/_-](\d{2,4}))?$/);
  if (numeric) {
    const day = parseInt(numeric[1]!, 10);
    const monthNum = parseInt(numeric[2]!, 10);
    if (monthNum < 1 || monthNum > 12 || day < 1 || day > 31) return null;
    return { month: MONTH_NAMES[monthNum - 1]!, day, year: numeric[3] ? normalizeYear(numeric[3]) : null };
  }

  // Day then month name (optional ordinal): "11 June", "11th June"
  const dayMonth = t.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[\\s_-]+(${MONTHS_PATTERN})$`, "i"));
  if (dayMonth) {
    return { month: MONTH_NORMALIZE[dayMonth[2]!.toLowerCase()] ?? dayMonth[2]!, day: parseInt(dayMonth[1]!, 10), year: null };
  }

  // Month name then day (optional ordinal): "June 11", "June 11th"
  const monthDay = t.match(new RegExp(`^(${MONTHS_PATTERN})[\\s_-]+(\\d{1,2})(?:st|nd|rd|th)?$`, "i"));
  if (monthDay) {
    return { month: MONTH_NORMALIZE[monthDay[1]!.toLowerCase()] ?? monthDay[1]!, day: parseInt(monthDay[2]!, 10), year: null };
  }

  return null;
}

/**
 * Format a parsed session date. With a year it becomes ISO (YYYY-MM-DD, ready
 * for the DB); without a year it stays "Month Day" so the caller can attach the
 * event's year later.
 */
export function formatSessionDate(parsed: { month: string; day: number; year: number | null }): string {
  if (parsed.year !== null) {
    const mm = String(MONTH_NAMES.indexOf(parsed.month) + 1).padStart(2, "0");
    return `${parsed.year}-${mm}-${String(parsed.day).padStart(2, "0")}`;
  }
  return `${parsed.month} ${parsed.day}`;
}

/**
 * Extract a session date that is NOT anchored by a period word, plus whatever
 * descriptive text follows it — e.g. "093 [TRAD] - 7_10 - Questao extra".
 *
 * Deliberately NOT used by parseTrackFilename. Without a period word to anchor
 * on, this pattern is loose enough to read "-11-12" out of the middle of an
 * ISO date, so the two guards below bail out on any filename that already
 * carries a full date. Only session-ranges.ts calls it, and only for tracks
 * left uncovered in range mode, so ordinary events never reach it.
 */
export function extractBareSessionDate(
  filename: string,
): { date: string; descriptor: string } | null {
  const baseName = filename.replace(/\.(mp3|wav|m4a|flac|ogg|mpeg)$/i, "");
  if (/\d{4}-\d{2}-\d{2}/.test(baseName)) return null;
  if (/(?:^|\D)\d{8}(?:\D|$)/.test(baseName)) return null;

  const m = baseName.match(
    new RegExp(`[\\s_-]+(${SESSION_DATE_TOKEN})(?:[\\s_-]+(.*))?$`, "i"),
  );
  if (!m) return null;
  const parsed = parseSessionDateToken(m[1]!);
  if (!parsed) return null;
  return {
    date: formatSessionDate(parsed),
    descriptor: (m[2] ?? "").replace(/[\s_-]+$/, "").trim(),
  };
}
