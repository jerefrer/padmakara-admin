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
 */

export interface ParsedTrack {
  trackNumber: number;
  speaker: string | null;
  title: string;
  language: string;
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
  PORTUGUÊS: "pt",
  PORTUGUESE: "pt",
  TIB: "tib",
  TIBETAN: "tib",
  TIBETANO: "tib",
  FR: "fr",
  FRENCH: "fr",
  FRANCÊS: "fr",
};

function normalizeLanguage(lang: string): string {
  const upper = lang.toUpperCase().trim();
  return LANGUAGE_MAP[upper] ?? lang.toLowerCase();
}

export function parseTrackFilename(filename: string): ParsedTrack {
  // Remove extension
  const baseName = filename.replace(/\.(mp3|wav|m4a|flac|ogg)$/i, "");

  let trackNumber = 0;
  let speaker: string | null = null;
  let title = baseName;
  let language = "en";
  let isTranslation = false;
  let date: string | null = null;
  let timePeriod: string | null = null;
  let partNumber: number | null = null;

  // Extract track number from beginning (with optional underscore, space, or hyphen)
  const numMatch = baseName.match(/^(\d+)[_\s-]/);
  let datePrefix: string | null = null;
  if (numMatch) {
    const num = parseInt(numMatch[1]!, 10);
    // Check if the number looks like a compact date (YYYYMMDD) rather than a track number.
    // A compact date has 8 digits, valid month (01-12), and valid day (01-31).
    const numStr = numMatch[1]!;
    if (numStr.length === 8) {
      const yyyy = parseInt(numStr.slice(0, 4), 10);
      const mm = parseInt(numStr.slice(4, 6), 10);
      const dd = parseInt(numStr.slice(6, 8), 10);
      if (yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        // This is a date prefix, not a track number
        trackNumber = 0;
        datePrefix = numStr;
        if (!date) {
          date = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
      } else {
        trackNumber = num;
      }
    } else if (numStr.length === 4 && num >= 1900 && num <= 2099) {
      // 4-digit number that looks like a year — check if followed by ISO date pattern
      // e.g. "2025-10-27-Guru_Yoga [ENG - Audio].m4a"
      if (/^\d{4}-\d{2}-\d{2}/.test(baseName)) {
        trackNumber = 0;
      } else {
        trackNumber = num;
      }
    } else {
      trackNumber = num;
    }
  }

  // Check if this is a translation track (TRAD marker)
  // Note: \b doesn't work after underscore since _ is a word char, so also check for _TRAD or space TRAD
  if (/(?:^|\s|_)TRAD(?:\s|$|-)/i.test(baseName)) {
    isTranslation = true;
    language = "pt"; // TRAD files are always Portuguese in this corpus
  }

  // Extract language from bracket notation [TIB], [ENG], [POR], [ENG - Audio], [ENG - Áudio]
  const bracketLangMatch = baseName.match(/\[([A-Z]+)(?:\s*-\s*[^\]]+)?\]/i);
  if (bracketLangMatch) {
    language = normalizeLanguage(bracketLangMatch[1]!);
    // Bracket notation is only used in Tibetan teacher events.
    // Any non-Tibetan bracket language is a translation.
    if (language !== "tib") {
      isTranslation = true;
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

  // Extract date and session info from parenthetical: (17 April AM), (18 April AM_part_1)
  const sessionMatch = baseName.match(
    /\((\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(AM|PM)(?:_part_(\d+))?\)/i,
  );
  if (sessionMatch) {
    const [, day, month, period, part] = sessionMatch;
    date = `${month} ${day}`;
    timePeriod = period!.toLowerCase() === "am" ? "morning" : "afternoon";
    if (part) partNumber = parseInt(part, 10);
  }

  // Extract speaker abbreviation
  // Pattern: "001 JKR - title" or "01 KPS [TIB] title" or "02_KPS [ENG] title" or "01-TPWR-..."
  const speakerMatch = baseName.match(
    /^\d+[_\s-]+([A-Z]{2,5})(?:\s+-|\s+\[|-)/i,
  );
  if (speakerMatch && speakerMatch[1]!.toUpperCase() !== "TRAD") {
    speaker = speakerMatch[1]!.toUpperCase();
  }

  // Extract clean title
  // Remove: track number, speaker, language tag, date, session info
  title = baseName
    // Remove leading ISO date prefix (e.g. "2025-10-27-")
    .replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, "")
    // Remove leading number and optional underscore/space/hyphen
    .replace(/^\d+[_\s-]+/, "");

  // Remove speaker abbreviation ONLY if we detected one
  if (speaker) {
    title = title
      .replace(new RegExp(`^${speaker}\\s+-\\s+`, "i"), "")
      .replace(new RegExp(`^${speaker}[\\s-]+`, "i"), "");
  }

  // Remove TRAD marker
  title = title
    .replace(/^TRAD\s+-\s+/i, "")
    .replace(/^TRAD\s+/i, "")
    // Remove language tag in brackets (including [ENG - Audio] patterns)
    .replace(/\[[A-Z]+(?:\s*-\s*[^\]]+)?\]\s*/i, "")
    // Remove ISO date
    .replace(/\s*\d{4}-\d{2}-\d{2}/, "")
    // Remove session info in parentheses
    .replace(
      /\s*-?\s*\(\d{1,2}\s+\w+\s+(AM|PM)(?:_part_\d+)?\)/i,
      "",
    )
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
    title,
    language,
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
