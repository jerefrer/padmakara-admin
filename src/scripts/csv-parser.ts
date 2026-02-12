/**
 * Wix CSV parser for retreat data migration.
 *
 * Parses the 62-column Wix export CSV and extracts structured data
 * for import into the Padmakara database.
 */

export interface WixRow {
  eventCode: string;
  wixId: string;
  teacherName: string;
  organization: string;
  dateRange: string;
  place: string;
  designation: string;
  title: string;
  guestName: string;
  description: string;
  sessionThemes: string;
  bibliography: string;
  audience: string;
  notes: string;
  onOff: boolean;

  audio1: {
    language: string;
    duration: string;
    trackCount: string;
    trackNames: string[];
    downloadUrl: string;
    editedStatus: string;
  };
  audio2: {
    language: string;
    duration: string;
    trackCount: string;
    trackNames: string[];
    downloadUrl: string;
    editedStatus: string;
  };
  transcript1: {
    language: string;
    status: string;
    pages: string;
    pdfDownload: string;
    coverJpg: string;
  };
  transcript2: {
    language: string;
    status: string;
    pages: string;
    pdfDownload: string;
    coverJpg: string;
  };
}

/** Parse the date range field → { startDate, endDate } */
export function parseDateRange(dateRange: string): {
  startDate: string | null;
  endDate: string | null;
} {
  if (!dateRange || !dateRange.trim()) return { startDate: null, endDate: null };

  const trimmed = dateRange.trim();

  // Pattern: "2017-11-14 a 2017-11-20"
  const rangeMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\s+a\s+(\d{4}-\d{2}-\d{2})$/,
  );
  if (rangeMatch) {
    return { startDate: rangeMatch[1]!, endDate: rangeMatch[2]! };
  }

  // Pattern: single date "2010-03-08"
  const singleMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (singleMatch) {
    return { startDate: singleMatch[1]!, endDate: singleMatch[1]! };
  }

  return { startDate: null, endDate: null };
}

/** Parse duration string like "02h 04min 29s" → seconds */
export function parseDuration(duration: string): number | null {
  if (!duration || !duration.trim()) return null;

  let totalSeconds = 0;
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)min/);
  const seconds = duration.match(/(\d+)s/);

  if (hours) totalSeconds += parseInt(hours[1]!, 10) * 3600;
  if (minutes) totalSeconds += parseInt(minutes[1]!, 10) * 60;
  if (seconds) totalSeconds += parseInt(seconds[1]!, 10);

  return totalSeconds > 0 ? totalSeconds : null;
}

/** Parse track count like "13 Faixas" → number */
export function parseTrackCount(trackCount: string): number {
  const match = trackCount.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/** Split pipe-separated teacher names */
export function parseTeachers(teacherName: string): string[] {
  if (!teacherName || !teacherName.trim()) return [];
  return teacherName
    .split(" | ")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Split pipe-separated organization names, normalizing variants */
export function parseOrganizations(org: string): string[] {
  if (!org || !org.trim()) return [];
  return org
    .split(" | ")
    .map((o) => o.trim())
    .filter(Boolean)
    .map(normalizeOrganization);
}

/** Normalize organization name variants to canonical form */
export function normalizeOrganization(name: string): string {
  const normalized = name.replace(/,\s*$/, "").trim();
  // F. Kangyur R / F. Kangyur R. / F. Kangyur Rinpoche → F. Kangyur Rinpoche
  if (/^F\.\s*Kangyur\s*R\.?$/i.test(normalized)) return "F. Kangyur Rinpoche";
  if (normalized === "Songtsen - Casa da Cultura do Tibete") return "Songtsen";
  if (normalized === "U.B.P. - União Budista Portuguesa") return "U.B.P.";
  return normalized;
}

/** Extract teacher abbreviation from name for matching with track filenames */
export function teacherAbbreviation(name: string): string {
  // Known mappings
  const abbrevMap: Record<string, string> = {
    "Jigme Khyentse Rinpoche": "JKR",
    "Pema Wangyal Rinpoche": "PWR",
    "Rangdrol Rinpoche": "RR",
    "Khenchen Pema Sherab Rinpoche": "KPS",
    "Matthieu Ricard": "MTR",
    "Khenpo Namgyal Phuntsok": "KNP",
    "Dilgo Khyentse Yangsi Rinpoche": "DKY",
    "Shechen Rabjam Rinpoche": "SRR",
    "K. Tenga Rinpoche": "KTR",
    "K. Trulshik Rinpoche": "KTR",
    "Chagdug Khadro": "CK",
    "Taklung Matrul Rinpoche": "TMR",
    "42º Sakya Trizin, Ratna Vajra Rinpoche": "ST",
    "41º Sakya Trichen": "ST",
    "Y. Mingyur Rinpoche": "YMR",
    "Chokyi Nyima Rinpoche": "CNR",
    "S.S. XIV Dalai Lama": "DL",
  };
  return abbrevMap[name] ?? name;
}

/**
 * Parse a raw CSV record (as returned by a CSV parser) into a structured WixRow.
 */
export function parseWixRow(raw: Record<string, string>): WixRow {
  const trackNames1 = raw["audio1-trackNames"]
    ? raw["audio1-trackNames"]
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const trackNames2 = raw["audio2-tracksTitles"]
    ? raw["audio2-tracksTitles"]
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return {
    eventCode: raw["eventCode"]?.trim() ?? "",
    wixId: raw["ID"]?.trim() ?? "",
    teacherName: raw["teacherName"]?.trim() ?? "",
    organization: raw["organização"]?.trim() ?? "",
    dateRange: raw["dateStart-dateEnd"]?.trim() ?? "",
    place: raw["placeTeaching"]?.trim() ?? "",
    designation: raw["currentDesignation"]?.trim() ?? "",
    title: raw["eventTitle"]?.trim() ?? "",
    guestName: raw["guestName"]?.trim() ?? "",
    description: raw["mainThemes"]?.trim() ?? "",
    sessionThemes: raw["sessionThemes"]?.trim() ?? "",
    bibliography: raw["eventBiblio"]?.trim() ?? "",
    audience: raw["distributionAudience"]?.trim() ?? "",
    notes: raw["notes"]?.trim() ?? "",
    onOff: raw["OnOff"]?.trim().toLowerCase() === "true",

    audio1: {
      language: raw["audio1-language"]?.trim() ?? "",
      duration: raw["audio1-duration"]?.trim() ?? "",
      trackCount: raw["audio1-tracksNo"]?.trim() ?? "",
      trackNames: trackNames1,
      downloadUrl: raw["audio1-Download-URL"]?.trim() ?? "",
      editedStatus: raw["audio1-EditedStatus"]?.trim() ?? "",
    },
    audio2: {
      language: raw["audio2-language"]?.trim() ?? "",
      duration: raw["audio2-Duration"]?.trim() ?? "",
      trackCount: raw["audio2-tracksNo"]?.trim() ?? "",
      trackNames: trackNames2,
      downloadUrl: raw["audio2-Download-URL"]?.trim() ?? "",
      editedStatus: raw["audio2-EditedStatus"]?.trim() ?? "",
    },
    transcript1: {
      language: raw["transcript1-language"]?.trim() ?? "",
      status: raw["transcript1-status"]?.trim() ?? "",
      pages: raw["transcript1-pages"]?.trim() ?? "",
      pdfDownload: raw["transcript1-PDF-download"]?.trim() ?? "",
      coverJpg: raw["transcript1-cover-jpg"]?.trim() ?? "",
    },
    transcript2: {
      language: raw["transcript2-language"]?.trim() ?? "",
      status: raw["transcript2-status"]?.trim() ?? "",
      pages: raw["transcrip2-pages"]?.trim() ?? "", // Note: typo in CSV header
      pdfDownload: raw["transcript2-pdf-download"]?.trim() ?? "",
      coverJpg: raw["transcript2-cover-jpg"]?.trim() ?? "",
    },
  };
}
