/**
 * Client-side track filename parser.
 * Mirrors the backend parser — extracts metadata from audio filenames.
 */

export interface ParsedTrack {
  id?: number;
  trackNumber: number;
  speaker: string | null;
  title: string;
  language?: string; // deprecated — kept for local-parse compat
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
  date: string | null;
  timePeriod: string | null;
  partNumber: number | null;
  originalFilename: string;
  file: File;
  isPractice?: boolean;
  fileFormat?: string | null;
}

export interface InferredSession {
  id?: number; // Database session id (optional - only present when from database)
  sessionNumber: number;
  date: string | null;
  timePeriod: string | null;
  titleEn: string;
  tracks: ParsedTrack[];
}

const LANGUAGE_MAP: Record<string, string> = {
  ENG: "en", ING: "en", ENGLISH: "en",
  POR: "pt", PORT: "pt", PORTUGUESE: "pt",
  TIB: "tib", TIBETAN: "tib",
  FR: "fr", FRENCH: "fr",
};

function normalizeLanguage(lang: string): string {
  return LANGUAGE_MAP[lang.toUpperCase().trim()] ?? lang.toLowerCase();
}

export function parseTrackFile(file: File): ParsedTrack {
  const filename = file.name;
  const baseName = filename.replace(/\.(mp3|wav|m4a|flac|ogg)$/i, "");

  let trackNumber = 0;
  let speaker: string | null = null;
  let title = baseName;
  let language = "en";
  let isTranslation = false;
  let date: string | null = null;
  let timePeriod: string | null = null;
  let partNumber: number | null = null;

  const numMatch = baseName.match(/^(\d+)[_\s]/);
  if (numMatch) trackNumber = parseInt(numMatch[1]!, 10);

  if (/(?:^|\s|_)TRAD(?:\s|$|-)/i.test(baseName)) {
    isTranslation = true;
    language = "pt";
  }

  const bracketLangMatch = baseName.match(/\[([A-Z]+)\]/i);
  if (bracketLangMatch) language = normalizeLanguage(bracketLangMatch[1]!);

  const isoDateMatch = baseName.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) date = isoDateMatch[1]!;

  const sessionMatch = baseName.match(
    /\((\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(AM|PM)(?:_part_(\d+))?\)/i,
  );
  if (sessionMatch) {
    const [, day, month, period, part] = sessionMatch;
    date = `${month} ${day}`;
    timePeriod = period!.toLowerCase() === "am" ? "morning" : "afternoon";
    if (part) partNumber = parseInt(part, 10);
  }

  // Detect speaker abbreviation — try multiple separator patterns
  const speakerMatch =
    baseName.match(/^\d+[_\s-]+([A-Z]{2,5})\s*-\s/i) ||    // "001 JKR - ..." or "001-JKR - ..."
    baseName.match(/^\d+[_\s-]+([A-Z]{2,5})\s+\[/i);       // "001 JKR [TIB] ..."
  if (speakerMatch && speakerMatch[1]!.toUpperCase() !== "TRAD") {
    speaker = speakerMatch[1]!.toUpperCase();
  }

  // Build title by stripping track number prefix
  title = baseName.replace(/^\d+[_\s-]+/, "");

  // Strip speaker abbreviation from the start of title
  if (speaker) {
    title = title
      .replace(new RegExp(`^${speaker}\\s*-\\s+`, "i"), "")
      .replace(new RegExp(`^${speaker}\\s*-\\s*`, "i"), "")
      .replace(new RegExp(`^${speaker}\\s+`, "i"), "");
  }
  // Fallback: strip any leading 2-5 letter abbreviation followed by " - " even if speaker wasn't detected
  if (!speaker) {
    const abbrevMatch = title.match(/^([A-Z]{2,5})\s*-\s+(.+)/i);
    if (abbrevMatch && abbrevMatch[1]!.toUpperCase() !== "TRAD") {
      speaker = abbrevMatch[1]!.toUpperCase();
      title = abbrevMatch[2]!;
    }
  }

  title = title
    .replace(/^TRAD\s*-\s+/i, "")
    .replace(/^TRAD\s+/i, "")
    .replace(/\[[A-Z]+\]\s*/i, "")
    .replace(/\s*\d{4}-\d{2}-\d{2}/, "")
    .replace(/\s*-?\s*\(\d{1,2}\s+\w+\s+(AM|PM)(?:_part_\d+)?\)/i, "")
    .trim();

  if (!title) title = baseName;

  return {
    trackNumber, speaker, title, language, isTranslation,
    languages: [language],
    originalLanguage: language,
    date, timePeriod, partNumber, originalFilename: filename, file,
  };
}

export function inferSessions(tracks: ParsedTrack[]): InferredSession[] {
  // Separate originals (with date/time info) from translations (without)
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
    // If no match found, put in a catch-all group
    if (!placed) {
      const fallbackKey = "unknown|unknown|";
      const group = groups.get(fallbackKey) ?? [];
      group.push(trad);
      groups.set(fallbackKey, group);
    }
  }

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
    // Use an original track for the session title, not a translation
    const sample = groupTracks.find((t) => !t.isTranslation) ?? groupTracks[0]!;

    let titleEn = "";
    if (sample.date && sample.timePeriod) {
      const periodLabel = sample.timePeriod === "morning" ? "Morning" : sample.timePeriod === "afternoon" ? "Afternoon" : "Evening";
      titleEn = `${sample.date} – ${periodLabel}`;
      if (sample.partNumber) titleEn += ` (Part ${sample.partNumber})`;
    } else if (sample.date) {
      titleEn = sample.date;
    } else {
      titleEn = `Session ${sessionNumber}`;
    }

    sessions.push({
      sessionNumber,
      date: sample.date,
      timePeriod: sample.timePeriod,
      titleEn,
      tracks: groupTracks.sort((a, b) => {
        if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
        // Original before translation within same track number
        const transOrd = (a.isTranslation ? 1 : 0) - (b.isTranslation ? 1 : 0);
        if (transOrd !== 0) return transOrd;
        // Then by language priority: EN → PT → ES → FR → others
        const langOrd: Record<string, number> = { en: 0, pt: 1, es: 2, fr: 3 };
        return (langOrd[a.originalLanguage] ?? 4) - (langOrd[b.originalLanguage] ?? 4);
      }),
    });
    sessionNumber++;
  }

  return sessions;
}

/* ───────────── Folder Name Parser ───────────── */

/**
 * Metadata extracted from a retreat folder name.
 * Format: "2025-04-17_18-JKR-Treino_da_Mente_2 [ING+POR]"
 */
export interface FolderMetadata {
  startDate: string | null;   // "2025-04-17"
  endDate: string | null;     // "2025-04-18"
  teacherAbbrev: string | null; // "JKR"
  groupSlug: string | null;   // "Treino da Mente 2"
  languages: string[];        // ["en", "pt"]
  defaultTitle: string;       // "2025 Spring Retreat"
  defaultTitlePt: string;     // "Retiro de Primavera 2025"
}

/**
 * Parse a retreat folder name into structured metadata.
 *
 * Expects format: {YYYY-MM-DD}_{DD}-{TEACHER}-{Group_Name} [{LANG+LANG}]
 * Examples:
 *   "2025-04-17_18-JKR-Treino_da_Mente_2 [ING+POR]"
 *   "2017-11-14_20-KPS-Praticas_Preliminares [TIB+ENG+POR]"
 */
export function parseFolderName(name: string): FolderMetadata {
  let startDate: string | null = null;
  let endDate: string | null = null;
  let teacherAbbrev: string | null = null;
  let groupSlug: string | null = null;
  let languages: string[] = [];

  // Extract languages from brackets: [ING+POR]
  const langMatch = name.match(/\[([A-Z+]+)\]/i);
  if (langMatch) {
    languages = langMatch[1]!.split("+").map((l) => {
      const map: Record<string, string> = { ING: "en", ENG: "en", POR: "pt", TIB: "tib", FR: "fr" };
      return map[l.toUpperCase()] ?? l.toLowerCase();
    });
  }

  // Remove the bracket portion for further parsing
  const base = name.replace(/\s*\[[^\]]*\]\s*$/, "").trim();

  // Match: YYYY-MM-DD_DD-TEACHER-Group_Name
  const mainMatch = base.match(
    /^(\d{4}-\d{2}-\d{2})(?:_(\d{1,2}))?-([A-Z]{2,5})-(.+)$/i,
  );

  if (mainMatch) {
    const [, dateStr, endDay, teacher, groupRaw] = mainMatch;
    startDate = dateStr!;
    teacherAbbrev = teacher!.toUpperCase();

    // Derive end date from start date + end day
    if (endDay && startDate) {
      const [y, m] = startDate.split("-");
      endDate = `${y}-${m}-${endDay.padStart(2, "0")}`;
    } else {
      endDate = startDate;
    }

    // Convert underscores to spaces for group name
    groupSlug = groupRaw!.replace(/_/g, " ").trim();
  }

  // Generate default titles from date
  const defaultTitle = startDate ? generateSeasonTitle(startDate, "en") : "New Retreat";
  const defaultTitlePt = startDate ? generateSeasonTitle(startDate, "pt") : "Novo Retiro";

  return { startDate, endDate, teacherAbbrev, groupSlug, languages, defaultTitle, defaultTitlePt };
}

/** Generate a title like "2025 Spring Retreat" / "Retiro de Primavera 2025" from a date string */
function generateSeasonTitle(dateStr: string, lang: "en" | "pt"): string {
  const month = parseInt(dateStr.split("-")[1]!, 10);
  const year = dateStr.split("-")[0]!;
  // March-May = Spring, June-Aug = Summer, Sep-Nov = Fall, Dec-Feb = Winter
  if (lang === "pt") {
    let season: string;
    if (month >= 3 && month <= 5) season = "Primavera";
    else if (month >= 6 && month <= 8) season = "Verão";
    else if (month >= 9 && month <= 11) season = "Outono";
    else season = "Inverno";
    return `Retiro de ${season} ${year}`;
  }
  let season: string;
  if (month >= 3 && month <= 5) season = "Spring";
  else if (month >= 6 && month <= 8) season = "Summer";
  else if (month >= 9 && month <= 11) season = "Fall";
  else season = "Winter";
  return `${year} ${season} Retreat`;
}

/** Human-readable file size */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable language name */
export function languageLabel(code: string | undefined): string {
  if (!code) return "Unknown";
  const labels: Record<string, string> = {
    en: "English", pt: "Portuguese", tib: "Tibetan", fr: "French",
  };
  return labels[code] ?? code.toUpperCase();
}
