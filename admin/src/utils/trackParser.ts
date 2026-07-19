/**
 * Client-side track filename parser.
 * Mirrors the backend parser — extracts metadata from audio filenames.
 */

export type TrackMediaType = "audio" | "video";

export interface ParsedTrack {
  id?: number;
  trackNumber: number;
  speaker: string | null;
  title: string;
  titleEn?: string;
  titlePt?: string;
  titleEnReviewed?: boolean;
  titlePtReviewed?: boolean;
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
  mediaType: TrackMediaType;
}

/** A single video attached to an event (event-wide, ordered by position — no
 *  longer scoped to a session). */
export interface EventVideo {
  id: number;
  eventId: number;
  bunnyVideoId: string;
  position: number;
  titleEn: string | null;
  titlePt: string | null;
  videoDate: string | null;
  durationSeconds: number | null;
  posterUrl: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface InferredSession {
  id?: number; // Database session id (optional - only present when from database)
  sessionNumber: number;
  date: string | null;
  timePeriod: string | null;
  titleEn: string;
  titlePt: string;
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
  tracks: ParsedTrack[];
}

const LANGUAGE_MAP: Record<string, string> = {
  ENG: "en", ING: "en", ENGLISH: "en",
  POR: "pt", PORT: "pt", PORTUGUESE: "pt", TRAD: "pt",
  TIB: "tib", TIBETAN: "tib",
  FR: "fr", FRENCH: "fr",
};

function normalizeLanguage(lang: string): string {
  return LANGUAGE_MAP[lang.toUpperCase().trim()] ?? lang.toLowerCase();
}

/** Recognized language codes (distinct values of LANGUAGE_MAP): en, pt, tib, fr. */
const RECOGNIZED_LANGS = new Set(Object.values(LANGUAGE_MAP));

const AUDIO_EXT_RE = /\.(mp3|wav|m4a|flac|ogg)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|webm)$/i;

export function isAudioFilename(name: string): boolean {
  return AUDIO_EXT_RE.test(name);
}

export function isVideoFilename(name: string): boolean {
  return VIDEO_EXT_RE.test(name);
}

export function isMediaFilename(name: string): boolean {
  return isAudioFilename(name) || isVideoFilename(name);
}

export function detectMediaType(name: string): TrackMediaType {
  return isVideoFilename(name) ? "video" : "audio";
}

// ─── Session date parsing ─────────────────────────────────────────────────
// Mirrors the backend parser (src/services/track-parser.ts). A trailing
// marker like "(11 June PM)" carries the session; the date part comes in
// several shapes (day-month, month-day, ordinals, numeric DD/MM[/YYYY]) in
// English or Portuguese and all resolve to the same normalized form.

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

const MONTHS_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December"
  + "|Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro";

const SESSION_DATE_TOKEN =
  `(?:\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?`
  + `|\\d{1,2}(?:st|nd|rd|th)?[\\s_-]+(?:${MONTHS_PATTERN})`
  + `|(?:${MONTHS_PATTERN})[\\s_-]+\\d{1,2}(?:st|nd|rd|th)?)`;

const PERIOD_LABELS: Record<"en" | "pt", Record<string, string>> = {
  en: { morning: "Morning", afternoon: "Afternoon", evening: "Evening" },
  pt: { morning: "Manhã", afternoon: "Tarde", evening: "Noite" },
};
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_PT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

/** Extract (monthIndex, day) from a session date string. Handles ISO dates
 *  (YYYY-MM-DD) and strings containing an English month name (case-insensitive,
 *  in either "Month Day" or "Day Month" order — the shape `formatSessionDate`
 *  produces for non-ISO dates). Returns `null` when neither shape matches, so
 *  the caller can fall back to reusing the string verbatim. */
function extractMonthDay(date: string): { monthIndex: number; day: number } | null {
  const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return { monthIndex: parseInt(iso[2]!, 10) - 1, day: parseInt(iso[3]!, 10) };
  }

  const monthMatch = date.match(new RegExp(`(${MONTHS_EN.join("|")})`, "i"));
  if (!monthMatch) return null;
  const monthIndex = MONTHS_EN.findIndex((m) => m.toLowerCase() === monthMatch[1]!.toLowerCase());
  if (monthIndex === -1) return null;

  const dayMatch = date.match(/\b(\d{1,2})\b/);
  if (!dayMatch) return null;
  const day = parseInt(dayMatch[1]!, 10);
  if (day < 1 || day > 31) return null;

  return { monthIndex, day };
}

/** Localise a session's date+period default title. `date` may be an ISO date
 *  (YYYY-MM-DD) or a string containing an English month name (e.g. "10 June",
 *  "June 10") — both shapes are localised per `lang`. Any other string (no
 *  month recognisable) is reused verbatim. */
export function formatSessionTitle(
  date: string | null,
  timePeriod: string | null,
  partNumber: number | null,
  lang: "en" | "pt",
): string {
  const period = timePeriod ? PERIOD_LABELS[lang][timePeriod] ?? "" : "";
  let datePart = date ?? "";
  const extracted = date ? extractMonthDay(date) : null;
  if (extracted) {
    datePart = lang === "pt"
      ? `${extracted.day} de ${MONTHS_PT[extracted.monthIndex]}`
      : `${MONTHS_EN[extracted.monthIndex]} ${extracted.day}`;
  }
  let title = datePart && period ? `${datePart} – ${period}` : (datePart || period);
  if (!title) return lang === "pt" ? "Sessão" : "Session";
  if (partNumber) title += lang === "pt" ? ` (Parte ${partNumber})` : ` (Part ${partNumber})`;
  return title;
}

function normalizeYear(y: string): number {
  const n = parseInt(y, 10);
  if (y.length <= 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

function parseSessionDateToken(
  token: string,
): { month: string; day: number; year: number | null } | null {
  const t = token.trim();

  const numeric = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (numeric) {
    const day = parseInt(numeric[1]!, 10);
    const monthNum = parseInt(numeric[2]!, 10);
    if (monthNum < 1 || monthNum > 12 || day < 1 || day > 31) return null;
    return { month: MONTH_NAMES[monthNum - 1]!, day, year: numeric[3] ? normalizeYear(numeric[3]) : null };
  }

  const dayMonth = t.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[\\s_-]+(${MONTHS_PATTERN})$`, "i"));
  if (dayMonth) {
    return { month: MONTH_NORMALIZE[dayMonth[2]!.toLowerCase()] ?? dayMonth[2]!, day: parseInt(dayMonth[1]!, 10), year: null };
  }

  const monthDay = t.match(new RegExp(`^(${MONTHS_PATTERN})[\\s_-]+(\\d{1,2})(?:st|nd|rd|th)?$`, "i"));
  if (monthDay) {
    return { month: MONTH_NORMALIZE[monthDay[1]!.toLowerCase()] ?? monthDay[1]!, day: parseInt(monthDay[2]!, 10), year: null };
  }

  return null;
}

function formatSessionDate(parsed: { month: string; day: number; year: number | null }): string {
  if (parsed.year !== null) {
    const mm = String(MONTH_NAMES.indexOf(parsed.month) + 1).padStart(2, "0");
    return `${parsed.year}-${mm}-${String(parsed.day).padStart(2, "0")}`;
  }
  return `${parsed.month} ${parsed.day}`;
}

/** Heuristic: does this title text read as Portuguese? (diacritics + stopwords) */
export function detectTitleLanguage(title: string): "en" | "pt" {
  const t = title.toLowerCase();
  if (/[ãõáéíóúâêôàç]/.test(t)) return "pt";
  if (/\b(de|da|do|das|dos|e|para|com|sessão|oração|orações|ensinamentos?)\b/.test(t)) return "pt";
  return "en";
}

export function parseTrackFile(file: File): ParsedTrack {
  const filename = file.name;
  const baseName = filename.replace(AUDIO_EXT_RE, "").replace(VIDEO_EXT_RE, "");
  const mediaType = detectMediaType(filename);

  let trackNumber = 0;
  let speaker: string | null = null;
  let title = baseName;
  let languages: string[] = ["en"];
  let originalLanguage = "en";
  let isTranslation = false;
  let date: string | null = null;
  let timePeriod: string | null = null;
  let partNumber: number | null = null;

  // Extract the track number from the start. The separator may be an
  // underscore, space, OR hyphen (e.g. "07-KNP-..."). Guard against date-like
  // prefixes: an 8-digit YYYYMMDD or a 4-digit ISO-date year is not a track
  // number. Mirrors the backend parser.
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
        date = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      } else {
        trackNumber = num;
      }
    } else if (numStr.length === 4 && num >= 1900 && num <= 2099 && /^\d{4}-\d{2}-\d{2}/.test(baseName)) {
      trackNumber = 0;
    } else {
      trackNumber = num;
    }
  }

  if (/(?:^|\s|_)TRAD(?:[\s_-]|$)/i.test(baseName)) {
    isTranslation = true;
    languages = ["pt"];
    originalLanguage = "pt";
  }

  // Bracket notation — single ([TIB]) and multi-language ([TIB+ENG],
  // [TIB+ENG+POR]) files. Mirrors the backend parser: split on + & / , and
  // keep only recognized language codes (descriptors like [ENG - Audio] drop).
  const bracketLangMatch = baseName.match(/\[([^\]]+)\]/);
  if (bracketLangMatch) {
    const codes = bracketLangMatch[1]!
      .split(/[+&/,]/)
      .map((tok) => normalizeLanguage(tok.split("-")[0]!.trim()))
      .filter((code) => RECOGNIZED_LANGS.has(code));
    if (codes.length > 0) {
      languages = codes;
      originalLanguage = codes[0]!;
      isTranslation = codes.length === 1 && codes[0] !== "tib";
    }
  }

  const isoDateMatch = baseName.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) date = isoDateMatch[1]!;

  // Session marker: parenthesized first, then a trailing non-parenthesized
  // form. The date part is captured whole and re-parsed, so all supported
  // shapes are handled (see SESSION_DATE_TOKEN).
  const parenSession = baseName.match(
    new RegExp(`\\(\\s*(${SESSION_DATE_TOKEN})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)[^)]*)?\\s*\\)`, "i"),
  );
  const trailingSession = !parenSession
    ? baseName.match(
        new RegExp(`[\\s_-]+(${SESSION_DATE_TOKEN})[\\s_-]+(AM|PM)(?:[\\s_-]+part[\\s_-]*(\\d+)\\w*)?$`, "i"),
      )
    : null;

  const sessMatch = parenSession ?? trailingSession;
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

  // Detect speaker abbreviation. The abbreviation may be followed by " - ", a
  // language bracket (with or without a leading space), or a bare hyphen
  // ("01-KNP-[TIB+PT]..."). Mirrors the backend parser's separator set.
  const speakerMatch = baseName.match(/^\d+[_\s-]+([A-Z]{2,5})(?:\s+-|\s*\[|-)/i);
  if (speakerMatch && speakerMatch[1]!.toUpperCase() !== "TRAD") {
    speaker = speakerMatch[1]!.toUpperCase();
  }

  // Fallback: all-caps abbreviation followed directly by title, space- or
  // underscore-separated ("001 YMR Conference", "001_YMR_Conference").
  // Case-sensitive so lowercase title words are never captured. Mirrors the
  // backend parser's direct fallback.
  if (!speaker) {
    const directMatch = baseName.match(/^\d+[_\s-]+([A-Z]{2,5})[\s_]+/);
    if (directMatch && directMatch[1] !== "TRAD") {
      speaker = directMatch[1]!;
    }
  }

  // Build title by stripping track number prefix
  title = baseName.replace(/^\d+[_\s-]+/, "");

  // Strip speaker abbreviation from the start of title
  if (speaker) {
    title = title
      .replace(new RegExp(`^${speaker}\\s*-\\s+`, "i"), "")
      .replace(new RegExp(`^${speaker}\\s*-\\s*`, "i"), "")
      .replace(new RegExp(`^${speaker}[\\s_]+`, "i"), "");
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
    .replace(/^TRAD[\s_]+/i, "")
    .replace(/\[[^\]]+\]\s*/i, "")
    .replace(/\s*\d{4}-\d{2}-\d{2}/, "");

  // Remove the exact session marker matched above (all supported date shapes).
  if (sessionMarker) {
    title = title.replace(sessionMarker, "");
  }

  title = title
    // Remove trailing dashes/whitespace left behind by the marker.
    .replace(/[\s-]+$/, "")
    .trim();

  if (!title) title = baseName;

  // Pre-fill the EN/PT title fields by detected language, leaving the other
  // blank — a human-entered filename title is not AI output, so both sides
  // start reviewed. A TRAD track's title is Portuguese by contract, even when
  // the heuristic can't tell (no diacritics/stopwords, e.g. "Conferencia").
  const _lang = isTranslation && originalLanguage === "pt" ? "pt" : detectTitleLanguage(title);

  return {
    trackNumber, speaker, title, language: originalLanguage, isTranslation,
    languages,
    originalLanguage,
    titleEn: _lang === "en" ? title : "",
    titlePt: _lang === "pt" ? title : "",
    titleEnReviewed: true,
    titlePtReviewed: true,
    date, timePeriod, partNumber, originalFilename: filename, file,
    mediaType,
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

    const titleEn = formatSessionTitle(sample.date, sample.timePeriod, sample.partNumber, "en");
    const titlePt = formatSessionTitle(sample.date, sample.timePeriod, sample.partNumber, "pt");

    sessions.push({
      sessionNumber,
      date: sample.date,
      timePeriod: sample.timePeriod,
      titleEn,
      titlePt,
      titleEnReviewed: true,
      titlePtReviewed: true,
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

/**
 * Folder-name speaker fallback.
 *
 * When a dropped folder names its teacher (e.g. "2025-04-17_18-JKR-…") but none
 * of the track filenames carry a speaker abbreviation, every track is
 * attributed to that folder teacher. The gate is folder-level and
 * all-or-nothing: if even one filename already names a speaker, the folder's
 * filenames are treated as authoritative and nothing is changed (a mixed folder
 * may carry guest speakers). Returns `sessions` unchanged — same references —
 * when the fallback does not apply, so callers relying on stable track identity
 * (memoized table rows) are undisturbed.
 */
export function applyFolderSpeakerFallback(
  sessions: InferredSession[],
  folderSpeaker: string | null,
): InferredSession[] {
  if (!folderSpeaker) return sessions;
  const anyFilenameSpeaker = sessions.some((s) => s.tracks.some((t) => t.speaker));
  if (anyFilenameSpeaker) return sessions;
  return sessions.map((s) => ({
    ...s,
    tracks: s.tracks.map((t) => ({ ...t, speaker: folderSpeaker })),
  }));
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
