/**
 * Builds download filenames that follow docs/NAMING-CONVENTIONS.md, so a
 * downloaded ZIP (or single track) can be re-imported as-is — the emitted
 * name round-trips through `parseTrackFilename` (see track-filename tests).
 *
 * Shape: "NNN SPEAKER [TAGS] Title (D Month AM).ext"
 */

const LANGUAGE_TAGS: Record<string, string> = {
  en: "ENG",
  pt: "POR",
  tib: "TIB",
  fr: "FRA",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface TrackNameInfo {
  trackNumber: number;
  title: string;
  speaker: string | null;
  languages: string[];
  isTranslation: boolean;
  /** S3 key or original filename — only its extension is used (default mp3). */
  s3Key: string | null;
}

export interface SessionNameInfo {
  /** ISO session date (YYYY-MM-DD) or null when unknown. */
  sessionDate: string | null;
  /** "morning" | "afternoon" | "evening" | null. */
  timePeriod: string | null;
  partNumber: number | null;
}

/** Strip characters that break filenames or would confuse the importer
 *  (brackets read as language tags). Accents are kept — the parser handles
 *  them and Portuguese titles stay readable. */
function sanitizeTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extensionOf(s3Key: string | null): string {
  const base = (s3Key ?? "").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot > 0 && dot < base.length - 1) return base.slice(dot + 1).toLowerCase();
  return "mp3";
}

/** "(17 April AM)" from an ISO session date + time period; "" when unknown. */
export function buildSessionMarker(session: SessionNameInfo): string {
  const m = (session.sessionDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !session.timePeriod) return "";
  const month = MONTH_NAMES[parseInt(m[2]!, 10) - 1];
  if (!month) return "";
  const day = parseInt(m[3]!, 10);
  const period = session.timePeriod === "morning" ? "AM" : "PM";
  const part = session.partNumber ? ` part ${session.partNumber}` : "";
  return `(${day} ${month} ${period}${part})`;
}

/**
 * Convention filename for one track. Emission rules (mirroring what the
 * importer detects):
 * - multi-language file → "[TAG1+TAG2]" in the track's stored language order
 *   (languages[0] round-trips as originalLanguage);
 * - English original → untagged (English is the importer's default; "[ENG]"
 *   would mark it as the translation of a Tibetan original);
 * - English translation → "[ENG]";
 * - Portuguese translation → "TRAD" in the speaker slot when the track has no
 *   speaker (the team's habitual form), "SPEAKER [POR]" when it has one;
 * - any other single language → its tag. Note the importer reads a single
 *   non-Tibetan tag as a translation, so a Portuguese/French ORIGINAL loses
 *   its isTranslation=false on re-import — accepted edge case.
 */
export function buildConventionFilename(
  track: TrackNameInfo,
  session: SessionNameInfo,
): string {
  const number = String(track.trackNumber).padStart(3, "0");
  const languages = track.languages.length > 0 ? track.languages : ["en"];

  let speakerSlot = track.speaker ?? "";
  let tag = "";
  if (languages.length > 1) {
    tag = `[${languages.map((l) => LANGUAGE_TAGS[l] ?? l.toUpperCase()).join("+")}]`;
  } else {
    const lang = languages[0]!;
    if (lang === "en") {
      tag = track.isTranslation ? "[ENG]" : "";
    } else if (lang === "pt" && track.isTranslation && !speakerSlot) {
      speakerSlot = "TRAD";
    } else {
      tag = `[${LANGUAGE_TAGS[lang] ?? lang.toUpperCase()}]`;
    }
  }

  const marker = buildSessionMarker(session);
  const title = sanitizeTitle(track.title) || `Track ${track.trackNumber}`;

  // "NNN" + speaker slot + tag, then "- Title" when nothing separates the
  // title from the number/speaker (a bracket tag already acts as separator).
  const head = [number, speakerSlot, tag].filter(Boolean).join(" ");
  const separator = tag ? " " : " - ";
  const tail = marker ? ` ${marker}` : "";
  return `${head}${separator}${title}${tail}.${extensionOf(track.s3Key)}`;
}
