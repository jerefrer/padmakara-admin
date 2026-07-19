/**
 * Track filename parser.
 *
 * Handles all known naming conventions from Padmakara retreats:
 *
 * Pattern 1 (modern, with session info):
 *   "001 JKR - The daily practice in three parts-(17 April AM).mp3"
 *
 * Pattern 2 (translation):
 *   "001 TRAD - A pratica diaria em tres partes.mp3"
 *
 * Pattern 3 (language tags in brackets):
 *   "01 KPS [TIB] Initial prayers 2017-11-14.mp3"
 *
 * Pattern 4 (underscore prefix for translations):
 *   "02_KPS [ENG] Introduction to the text 2017-11-14.mp3"
 *
 * Pattern 5 (TRAD with date):
 *   "02_TRAD Introducao ao texto 2017-11-14.mp3"
 *
 * Pattern 6 (combo speakers):
 *   "016 KPS+JKR Intention in practicing.mp3"  (two teachers co-teaching)
 *   "019 JKR+TRAD - Initial prayers-(7 April AM_part_1).mp3"  (original + translation mixed)
 *   "050 PWR+TRAD - Conclusion of the teaching-(21 April PM part 2).mp3"
 */

export interface ParsedTrack {
  trackNumber: number;
  speaker: string | null;
  speakers: string[];
  title: string;
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
  date: string | null;
  timePeriod: string | null;
  partNumber: number | null;
  originalFilename: string;
}

const LANGUAGE_MAP: Record<string, string> = {
  ENG: "en",
  ING: "en",
  ENGLISH: "en",
  POR: "pt",
  PORT: "pt",
  PT: "pt",
  TRAD: "pt", // bracketed [TRAD] — "TRAD" means Portuguese translation
  PORTUGUÊS: "pt",
  PORTUGUESE: "pt",
  TIB: "tib",
  TIBETAN: "tib",
  TIBETANO: "tib",
  FR: "fr",
  FRA: "fr",
  FRENCH: "fr",
  FRANCÊS: "fr",
};

/** Recognized language codes (the distinct values of LANGUAGE_MAP): en, pt, tib, fr. */
const RECOGNIZED_LANGS = new Set(Object.values(LANGUAGE_MAP));

/** Tokens that are NOT teacher abbreviations (language markers, group names, etc.) */
const NON_TEACHER_TOKENS = new Set([
  "TRAD", "PT", "ENG", "TIB", "POR", "FR",
  "PBD", "SHA", "PP1", "PP2", "PP3", "PP4", "TM1", "TM2",
  "PART", "GRP", "ALUNA", "TSOK", "TRA", "HH",
]);

function normalizeLanguage(lang: string): string {
  const upper = lang.toUpperCase().trim();
  return LANGUAGE_MAP[upper] ?? lang.toLowerCase();
}

// ─── Session date parsing ─────────────────────────────────────────────────
//
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
const SESSION_DATE_TOKEN =
  `(?:\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?`
  + `|\\d{1,2}(?:st|nd|rd|th)?[\\s_-]+(?:${MONTHS_PATTERN})`
  + `|(?:${MONTHS_PATTERN})[\\s_-]+\\d{1,2}(?:st|nd|rd|th)?)`;

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
function parseSessionDateToken(
  token: string,
): { month: string; day: number; year: number | null } | null {
  const t = token.trim();

  // Numeric day-first: 11/06, 11-06, 11/06/2026, 11-06-2026
  const numeric = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
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
function formatSessionDate(parsed: { month: string; day: number; year: number | null }): string {
  if (parsed.year !== null) {
    const mm = String(MONTH_NAMES.indexOf(parsed.month) + 1).padStart(2, "0");
    return `${parsed.year}-${mm}-${String(parsed.day).padStart(2, "0")}`;
  }
  return `${parsed.month} ${parsed.day}`;
}

export function parseTrackFilename(filename: string): ParsedTrack {
  // Remove extension
  const baseName = filename.replace(/\.(mp3|wav|m4a|flac|ogg|mpeg)$/i, "");

  let trackNumber = 0;
  let speaker: string | null = null;
  const speakers: string[] = [];
  let title = baseName;
  let languages: string[] = ["en"];
  let originalLanguage = "en";
  let isTranslation = false;
  let date: string | null = null;
  let timePeriod: string | null = null;
  let partNumber: number | null = null;
  let hasTradCombo = false;

  // Extract track number from beginning (with optional underscore, space, or hyphen)
  const numMatch = baseName.match(/^(\d+)[_\s-]/);
  if (numMatch) {
    const num = parseInt(numMatch[1]!, 10);
    const numStr = numMatch[1]!;
    if (numStr.length === 8) {
      const yyyy = parseInt(numStr.slice(0, 4), 10);
      const mm = parseInt(numStr.slice(4, 6), 10);
      const dd = parseInt(numStr.slice(6, 8), 10);
      if (yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        trackNumber = 0;
        if (!date) {
          date = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
      } else {
        trackNumber = num;
      }
    } else if (numStr.length === 4 && num >= 1900 && num <= 2099) {
      if (/^\d{4}-\d{2}-\d{2}/.test(baseName)) {
        trackNumber = 0;
      } else {
        trackNumber = num;
      }
    } else {
      trackNumber = num;
    }
  }

  // Extract speaker abbreviation(s) — handle combos like KPS+JKR, JKR+TRAD, PWR&TRAD
  // Pattern: "001 KPS+JKR title" or "001 JKR+TRAD - title" or "001 PWR&TRAD - title"
  const comboMatch = baseName.match(
    /^\d+[_\s-]+([A-Z]{2,5})[+&]([A-Z]{2,5})(?:\s+-|\s+\[|\s+[A-Z]|\s+[a-z]|-)/i,
  );
  if (comboMatch) {
    const part1 = comboMatch[1]!.toUpperCase();
    const part2 = comboMatch[2]!.toUpperCase();

    // Check if either part is TRAD (translation marker)
    if (part2 === "TRAD" || part2 === "TRA") {
      // SPEAKER+TRAD: original + translation mixed in one track
      if (!NON_TEACHER_TOKENS.has(part1)) {
        speaker = part1;
        speakers.push(part1);
      }
      hasTradCombo = true;
      originalLanguage = "en";
      languages = ["en", "pt"];
      isTranslation = false; // it's BOTH, not just translation
    } else if (part1 === "TRAD" || part1 === "TRA") {
      // TRAD+SPEAKER (unlikely but handle)
      if (!NON_TEACHER_TOKENS.has(part2)) {
        speaker = part2;
        speakers.push(part2);
      }
      hasTradCombo = true;
      originalLanguage = "en";
      languages = ["en", "pt"];
      isTranslation = false;
    } else {
      // Two teachers co-teaching (e.g., KPS+JKR)
      if (!NON_TEACHER_TOKENS.has(part1)) speakers.push(part1);
      if (!NON_TEACHER_TOKENS.has(part2)) speakers.push(part2);
      speaker = speakers[0] ?? null;
    }
  } else {
    // Single speaker pattern — with separator (hyphen or bracket)
    const speakerMatch = baseName.match(
      /^\d+[_\s-]+([A-Z]{2,5})(?:\s+-|\s+\[|-)/i,
    );
    if (speakerMatch) {
      const sp = speakerMatch[1]!.toUpperCase();
      if (!NON_TEACHER_TOKENS.has(sp)) {
        speaker = sp;
        speakers.push(sp);
      }
    }

    // Fallback: all-caps abbreviation followed directly by title (no separator)
    // e.g., "001 JKR How to relate to our mind" or "001_YMR_Conference"
    // Case-sensitive: only matches UPPERCASE tokens to avoid capturing title words
    if (!speaker) {
      const directMatch = baseName.match(/^\d+[_\s-]+([A-Z]{2,5})[\s_]+/);
      if (directMatch) {
        const sp = directMatch[1]!;
        if (!NON_TEACHER_TOKENS.has(sp)) {
          speaker = sp;
          speakers.push(sp);
        }
      }
    }
  }

  // Check if this is a standalone translation track (TRAD marker, not in combo)
  if (!hasTradCombo && /(?:^|\s|_)TRAD(?:[\s_-]|$)/i.test(baseName)) {
    isTranslation = true;
    originalLanguage = "pt"; // TRAD tracks are Portuguese translations
    languages = ["pt"]; // TRAD is always Portuguese in this corpus
  }

  // Extract language(s) from bracket notation. Supports single tags
  // ([TIB], [ENG], [POR], [FRA]), the descriptive form [ENG - Audio] (the
  // "- Audio" suffix is ignored), and multi-language single files where the
  // recording carries several languages in sequence: [TIB+ENG], [ING+POR],
  // [TIB+ENG+POR]. Codes are split on + & / , and validated against the
  // known language set so descriptive words are discarded.
  const bracketLangMatch = baseName.match(/\[([^\]]+)\]/);
  if (bracketLangMatch && !hasTradCombo) {
    const codes = bracketLangMatch[1]!
      .split(/[+&/,]/)
      .map((tok) => normalizeLanguage(tok.split("-")[0]!.trim()))
      .filter((code) => RECOGNIZED_LANGS.has(code));
    if (codes.length > 0) {
      languages = codes;
      // The first code is the track's primary/source language (Tibetan in
      // TIB+ENG, English in ENG+POR).
      originalLanguage = codes[0]!;
      // Only a single non-Tibetan tag is a pure translation of a Tibetan
      // original. Multi-language files contain the teaching itself, so they
      // are kept as originals (matches the SPEAKER+TRAD combo behaviour).
      isTranslation = codes.length === 1 && codes[0] !== "tib";
    }
  }

  // Extract date - ISO format: 2017-11-14
  const isoDateMatch = baseName.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    date = isoDateMatch[1]!;
  } else {
    // Compact date format: 20030614 (common in older events)
    const compactDateMatch = baseName.match(/(?:^|\D)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\D|$)/);
    if (compactDateMatch) {
      date = `${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`;
    }
  }

  // Extract date and session info from a session marker. The date part is
  // captured whole (see SESSION_DATE_TOKEN) and re-parsed, so all supported
  // shapes — (11 June PM), (June 11th PM), (11/06 PM), (11-06-2026 PM), with an
  // optional "part N" — are handled. Parenthesized form first, then a trailing
  // non-parenthesized form: "-21_April_AM_part_1".
  const parenSession = baseName.match(
    new RegExp(`\\(\\s*(${SESSION_DATE_TOKEN})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)[^)]*)?\\s*\\)`, "i"),
  );
  const trailingSession = !parenSession
    ? baseName.match(
        new RegExp(`[\\s_-]+(${SESSION_DATE_TOKEN})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)\\w*)?$`, "i"),
      )
    : null;

  const sessMatch = parenSession ?? trailingSession;
  // The full matched marker, stripped from the title once we confirm the date
  // parses (a parenthetical that isn't actually a date is left untouched).
  let sessionMarker: string | null = null;
  if (sessMatch) {
    const parsedDate = parseSessionDateToken(sessMatch[1]!);
    if (parsedDate) {
      sessionMarker = sessMatch[0]!;
      date = formatSessionDate(parsedDate);
      timePeriod = sessMatch[2]!.toLowerCase() === "am" ? "morning" : "afternoon";
      if (sessMatch[3]) partNumber = parseInt(sessMatch[3], 10);
    }
  }

  // Build the speaker string for title cleanup (handle combos with + or &)
  const speakerPattern = comboMatch
    ? `${comboMatch[1]}[+&]${comboMatch[2]}`
    : speaker;

  // Extract clean title
  title = baseName
    // Remove leading ISO date prefix (e.g. "2025-10-27-")
    .replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, "")
    // Remove leading number and optional underscore/space/hyphen
    .replace(/^\d+[_\s-]+/, "");

  // Remove speaker abbreviation(s) ONLY if we detected them
  if (speakerPattern) {
    title = title
      .replace(new RegExp(`^${speakerPattern}\\s+-\\s+`, "i"), "")
      .replace(new RegExp(`^${speakerPattern}[\\s_-]+`, "i"), "");
  }

  // Remove TRAD marker
  title = title
    .replace(/^TRAD\s+-\s+/i, "")
    .replace(/^TRAD[\s_]+/i, "")
    // Remove language tag in brackets — single ([ENG]), descriptive
    // ([ENG - Audio]), and multi-language ([TIB+ENG], [TIB+ENG+POR]) forms.
    .replace(/\[[A-Z]+(?:[+&/,][A-Z]+)*(?:\s*-\s*[^\]]+)?\]\s*/i, "")
    // Remove ISO date
    .replace(/\s*\d{4}-\d{2}-\d{2}/, "")
    // Remove compact date (YYYYMMDD)
    .replace(/\s*\d{8}(?:\s|$)/, "");

  // Remove the exact session marker matched above (all supported date shapes).
  if (sessionMarker) {
    title = title.replace(sessionMarker, "");
  }

  title = title
    // Remove trailing "- AM", "- PM", standalone "AM", "PM" markers
    .replace(/\s*-?\s*\b(AM|PM)\b\s*$/i, "")
    // Remove trailing dashes and whitespace
    .replace(/[\s-]+$/, "")
    .trim();

  // Replace underscores with spaces in title
  title = title.replace(/_/g, " ");

  // If title is empty after cleanup, use original filename
  if (!title) {
    title = baseName;
  }

  return {
    trackNumber,
    speaker,
    speakers,
    title,
    languages,
    originalLanguage,
    isTranslation,
    date,
    timePeriod,
    partNumber,
    originalFilename: filename,
  };
}

export interface InferredSession {
  sessionNumber: number;
  date: string | null;
  timePeriod: string | null;
  partNumber: number | null;
  titleEn: string;
  tracks: ParsedTrack[];
}

/**
 * Group parsed tracks into inferred sessions based on date and time period.
 * Translation tracks without date/time info are matched to originals by track number.
 */
export function inferSessions(tracks: ParsedTrack[]): InferredSession[] {
  // Separate originals (with date/time info) from orphan translations (without)
  const originals = tracks.filter((t) => !t.isTranslation || t.date !== null);
  const orphanTranslations = tracks.filter((t) => t.isTranslation && t.date === null);

  // Group originals by (date, timePeriod, partNumber)
  const groups = new Map<string, ParsedTrack[]>();

  for (const track of originals) {
    const key = `${track.date ?? "unknown"}|${track.timePeriod ?? "unknown"}|${track.partNumber ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(track);
    groups.set(key, group);
  }

  // Match orphan translations to sessions by track number
  for (const trad of orphanTranslations) {
    let placed = false;
    for (const [, groupTracks] of groups) {
      if (groupTracks.some((t) => t.trackNumber === trad.trackNumber && !t.isTranslation)) {
        groupTracks.push(trad);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const fallbackKey = "unknown|unknown|";
      const group = groups.get(fallbackKey) ?? [];
      group.push(trad);
      groups.set(fallbackKey, group);
    }
  }

  // Sort groups chronologically (morning before afternoon, then by part number)
  const periodOrder: Record<string, number> = { morning: 0, afternoon: 1, evening: 2, unknown: 3 };
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [dateA, periodA, partA] = a.split("|");
    const [dateB, periodB, partB] = b.split("|");
    if (dateA !== dateB) return dateA!.localeCompare(dateB!);
    const pA = periodOrder[periodA!] ?? 3;
    const pB = periodOrder[periodB!] ?? 3;
    if (pA !== pB) return pA - pB;
    return (partA ?? "").localeCompare(partB ?? "");
  });

  const sessions: InferredSession[] = [];
  let sessionNumber = 1;

  for (const key of sortedKeys) {
    const groupTracks = groups.get(key)!;
    const sample = groupTracks.find((t) => !t.isTranslation) ?? groupTracks[0]!;

    let titleEn = "";
    if (sample.date && sample.timePeriod) {
      const periodLabel =
        sample.timePeriod === "morning" ? "Morning" : "Afternoon";
      titleEn = `${sample.date} - ${periodLabel}`;
      if (sample.partNumber) {
        titleEn += ` (Part ${sample.partNumber})`;
      }
    } else if (sample.date) {
      titleEn = sample.date;
    } else {
      titleEn = `Session ${sessionNumber}`;
    }

    sessions.push({
      sessionNumber,
      date: sample.date,
      timePeriod: sample.timePeriod,
      partNumber: sample.partNumber,
      titleEn,
      tracks: groupTracks.sort((a, b) => {
        if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
        return (a.isTranslation ? 1 : 0) - (b.isTranslation ? 1 : 0);
      }),
    });
    sessionNumber++;
  }

  return sessions;
}
