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
  PORTUGUÊS: "pt",
  PORTUGUESE: "pt",
  TIB: "tib",
  TIBETAN: "tib",
  TIBETANO: "tib",
  FR: "fr",
  FRENCH: "fr",
  FRANCÊS: "fr",
};

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
    // e.g., "001 JKR How to relate to our mind"
    // Case-sensitive: only matches UPPERCASE tokens to avoid capturing title words
    if (!speaker) {
      const directMatch = baseName.match(/^\d+[_\s-]+([A-Z]{2,5})\s+/);
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
  if (!hasTradCombo && /(?:^|\s|_)TRAD(?:\s|$|-)/i.test(baseName)) {
    isTranslation = true;
    originalLanguage = "pt"; // TRAD tracks are Portuguese translations
    languages = ["pt"]; // TRAD is always Portuguese in this corpus
  }

  // Extract language from bracket notation [TIB], [ENG], [POR], [ENG - Audio]
  const bracketLangMatch = baseName.match(/\[([A-Z]+)(?:\s*-\s*[^\]]+)?\]/i);
  if (bracketLangMatch) {
    const lang = normalizeLanguage(bracketLangMatch[1]!);
    if (!hasTradCombo) {
      languages = [lang];
      // Bracket notation is used in Tibetan teacher events.
      // Any non-Tibetan bracket language is a translation of Tibetan original.
      originalLanguage = lang; // track's own primary language
      if (lang !== "tib") {
        isTranslation = true;
      }
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

  // Month names (English + Portuguese) for session info extraction
  const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
    + "|Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro";

  // Extract date and session info from parenthetical: (17 April AM), (18 April_AM_Part_1), (20 April-AM-part 2)
  // The [^)]* after \d+ allows trailing sub-part indicators like "part_1_2" or "part 1a"
  const sessionMatch = baseName.match(
    new RegExp(`\\((\\d{1,2})[\\s_-]+(${MONTHS})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)[^)]*)?\\)`, "i"),
  );
  // Also match non-parenthesized session info at end: -21_April_AM_part_1, -21_April_AM_part_1_2
  const nonParenSessionMatch = !sessionMatch
    ? baseName.match(
        new RegExp(`[\\s-]+(\\d{1,2})[\\s_-]+(${MONTHS})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)\\w*)?$`, "i"),
      )
    : null;

  const sessMatch = sessionMatch ?? nonParenSessionMatch;
  if (sessMatch) {
    const [, day, month, period, part] = sessMatch;
    // Normalize Portuguese month names to English for consistent grouping
    const MONTH_NORMALIZE: Record<string, string> = {
      janeiro: "January", fevereiro: "February", março: "March", abril: "April",
      maio: "May", junho: "June", julho: "July", agosto: "August",
      setembro: "September", outubro: "October", novembro: "November", dezembro: "December",
    };
    const normalizedMonth = MONTH_NORMALIZE[month!.toLowerCase()] ?? month;
    date = `${normalizedMonth} ${day}`;
    timePeriod = period!.toLowerCase() === "am" ? "morning" : "afternoon";
    if (part) partNumber = parseInt(part, 10);
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
      .replace(new RegExp(`^${speakerPattern}[\\s-]+`, "i"), "");
  }

  // Remove TRAD marker
  title = title
    .replace(/^TRAD\s+-\s+/i, "")
    .replace(/^TRAD\s+/i, "")
    // Remove language tag in brackets (including [ENG - Audio] patterns)
    .replace(/\[[A-Z]+(?:\s*-\s*[^\]]+)?\]\s*/i, "")
    // Remove ISO date
    .replace(/\s*\d{4}-\d{2}-\d{2}/, "")
    // Remove compact date (YYYYMMDD)
    .replace(/\s*\d{8}(?:\s|$)/, "")
    // Remove session info in parentheses: (20 April_AM_part 1), (8 April-AM-Part 2), (21 April_AM_part 1a)
    .replace(
      /\s*-?\s*\(\d{1,2}[\s_-]+\w+[\s_-]+(AM|PM)(?:[\s_-]+part[\s_-]*\d+[^)]*)?\)/i,
      "",
    )
    // Remove non-parenthesized session info at end: -21_April_AM_part_1, -21_April_AM_part_1_2
    .replace(
      /[\s-]+\d{1,2}[\s_-]+\w+[\s_-]+(AM|PM)(?:[\s_-]+part[\s_-]*\d+\w*)?$/i,
      "",
    )
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
