/**
 * Library records: the association's Wix "libraryEvent" CSV export, parsed,
 * searched, matched against events and mapped onto event fields.
 *
 * Everything here is pure (no database access) so it can be tested on the
 * real export; the routes in routes/admin/library.ts do the persistence.
 * The CSV parsing and the designation / audience / teacher mapping reuse
 * scripts/csv-parser.ts, the same code the database was originally seeded
 * with.
 */

import { parse } from "csv-parse/sync";
import {
  parseWixRow,
  parseDateRange,
  parseTeachers,
  parseOrganizations,
  designationToGroup,
  type WixRow,
} from "../scripts/csv-parser.ts";

// ─── Parsing ─────────────────────────────────────────────────────────────

/** One CSV row, reduced to the columns we search on + the full raw row. */
export interface LibraryRecordInput {
  wixId: string;
  eventCode: string | null;
  title: string;
  teacherNames: string;
  guestName: string;
  organization: string;
  place: string;
  designation: string;
  dateRange: string;
  startDate: string | null;
  endDate: string | null;
  raw: Record<string, string>;
}

/** The export has typos like "2019-02-30"; Postgres rejects those, so drop them. */
function validDate(date: string | null): string | null {
  if (!date) return null;
  const t = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === date ? date : null;
}

/** Raised for an upload that is not a library export. */
export class LibraryCsvError extends Error {}

/**
 * Parse the CSV text of a library export. Rows without a Wix ID are skipped
 * (they cannot be linked to); a repeated Wix ID keeps its first row.
 */
export function parseLibraryCsv(text: string): LibraryRecordInput[] {
  const content = text.replace(/^﻿/, "");
  let rawRows: Record<string, string>[];
  try {
    rawRows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new LibraryCsvError(`Could not read the CSV: ${(err as Error).message}`);
  }
  if (rawRows.length === 0 || !("ID" in rawRows[0]!) || !("eventTitle" in rawRows[0]!)) {
    throw new LibraryCsvError(
      "This does not look like a library export (expected the ID and eventTitle columns)",
    );
  }

  const seen = new Set<string>();
  const records: LibraryRecordInput[] = [];
  for (const raw of rawRows) {
    const row = parseWixRow(raw);
    if (!row.wixId || seen.has(row.wixId)) continue;
    seen.add(row.wixId);
    const { startDate, endDate } = parseDateRange(row.dateRange);
    records.push({
      wixId: row.wixId,
      eventCode: row.eventCode || null,
      title: row.title,
      teacherNames: row.teacherName,
      guestName: row.guestName,
      organization: row.organization,
      place: row.place,
      designation: row.designation,
      dateRange: row.dateRange,
      startDate: validDate(startDate),
      endDate: validDate(endDate),
      raw,
    });
  }
  return records;
}

// ─── Normalisation ───────────────────────────────────────────────────────

/**
 * Accent-insensitive, case-insensitive fold used for every comparison:
 * "Śāntideva" and "shantideva" both become "santideva", "Lisboa" and "LISBOA"
 * the same. Punctuation becomes a single space.
 */
export function fold(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/sh/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Event codes differ in spacing/punctuation between sources. */
export function canonicalCode(code: string | null | undefined): string {
  return (code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(value: string | null | undefined): string[] {
  const f = fold(value);
  return f ? f.split(" ") : [];
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams, 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Similarity of two free-text strings, 0..1: how much of each side's tokens
 * is covered by tokens of the other (exact, or trigram-close for typos and
 * spelling variants). Symmetric so a shorter title still matches a longer one.
 */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const coverage = (from: string[], to: string[]) => {
    let sum = 0;
    for (const w of from) {
      let best = 0;
      for (const v of to) {
        if (w === v) {
          best = 1;
          break;
        }
        if (w.length >= 4 && v.length >= 4) best = Math.max(best, trigramSimilarity(w, v));
      }
      sum += best >= 0.6 ? best : 0;
    }
    return sum / from.length;
  };
  return (coverage(ta, tb) + coverage(tb, ta)) / 2;
}

// ─── Search ──────────────────────────────────────────────────────────────

/** The searchable view of a stored record. */
export interface SearchableRecord {
  wixId: string;
  eventCode: string | null;
  title: string;
  teacherNames: string;
  guestName: string;
  organization: string;
  place: string;
  designation: string;
  dateRange: string;
  startDate: string | null;
  endDate: string | null;
  /** Main + session themes text; lets "shantideva" find a teaching whose title doesn't name him. */
  themes?: string | null;
}

/** Per-field weights of a search hit: title and people matter most. */
const SEARCH_FIELDS: { key: keyof SearchableRecord; weight: number }[] = [
  { key: "title", weight: 5 },
  { key: "teacherNames", weight: 4 },
  { key: "guestName", weight: 3 },
  { key: "place", weight: 3 },
  { key: "eventCode", weight: 3 },
  { key: "dateRange", weight: 3 },
  { key: "organization", weight: 2 },
  { key: "designation", weight: 2 },
  { key: "themes", weight: 1.5 },
];

function tokenScore(token: string, words: string[], folded: string): number {
  if (words.includes(token)) return 1;
  if (words.some((w) => w.startsWith(token))) return 0.85;
  if (token.length >= 3 && folded.includes(token)) return 0.6;
  if (token.length >= 5) {
    let best = 0;
    for (const w of words) if (w.length >= 4) best = Math.max(best, trigramSimilarity(token, w));
    if (best >= 0.65) return best * 0.5;
  }
  return 0;
}

/**
 * Score one record against a free-text query. Every query token has to match
 * some field (otherwise 0); the score sums the best field weight per token.
 * "2019 shantideva lisboa" matches a record whose date, title/teacher and
 * place hold those three words.
 */
export function searchScore(record: SearchableRecord, query: string): number {
  const qTokens = tokens(query);
  if (qTokens.length === 0) return 0;

  const fields = SEARCH_FIELDS.map(({ key, weight }) => {
    // The CSV range text is "2017-11-14 a 2017-11-20": its "a" would match any
    // one-letter query token, so search the two dates themselves.
    const value =
      key === "eventCode"
        ? (record.eventCode ?? "").replace(/[-_]/g, " ")
        : key === "dateRange"
          ? `${record.startDate ?? ""} ${record.endDate ?? ""}`
          : (record[key] ?? "");
    const folded = fold(value as string);
    return { weight, folded, words: folded ? folded.split(" ") : [] };
  });

  let total = 0;
  for (const token of qTokens) {
    let best = 0;
    for (const f of fields) {
      const s = tokenScore(token, f.words, f.folded) * f.weight;
      if (s > best) best = s;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Rank records for a search box query; empty query lists newest first. */
export function searchRecords<T extends SearchableRecord>(records: T[], query: string, limit = 25): T[] {
  const byNewest = (a: T, b: T) => (b.startDate ?? "").localeCompare(a.startDate ?? "");
  if (!fold(query)) return [...records].sort(byNewest).slice(0, limit);
  return records
    .map((r) => ({ r, s: searchScore(r, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || byNewest(a.r, b.r))
    .slice(0, limit)
    .map((x) => x.r);
}

// ─── Matching an event to a record ───────────────────────────────────────

/** What we know about an event (saved, or still a draft in the form). */
export interface SuggestInput {
  wixId?: string | null;
  eventCode?: string | null;
  title?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  teacherNames?: string[];
  placeName?: string | null;
}

export type MatchReason =
  | { kind: "wixId" }
  | { kind: "code" }
  | { kind: "date"; detail: "same" | "overlap" | "close" | "month" }
  | { kind: "teacher"; detail: string }
  | { kind: "place"; detail: string }
  | { kind: "title"; detail: number };

export interface Suggestion<T> {
  record: T;
  /** 0..100 */
  score: number;
  reasons: MatchReason[];
}

const DAY_MS = 86_400_000;

function dayNumber(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.round(t / DAY_MS);
}

/** The date a code starts with: "20171114_20-KPS..." → "2017-11-14". */
function dateFromCode(code: string | null | undefined): string | null {
  const m = (code ?? "").match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function dateScore(
  input: SuggestInput,
  rec: SearchableRecord,
): { score: number; reason: MatchReason | null } {
  const aStart = dayNumber(input.startDate ?? dateFromCode(input.eventCode));
  if (aStart === null) return { score: 0, reason: null };
  const aEnd = dayNumber(input.endDate) ?? aStart;
  const bStart = dayNumber(rec.startDate);
  if (bStart === null) return { score: 0, reason: null };
  const bEnd = dayNumber(rec.endDate) ?? bStart;

  if (aStart === bStart) return { score: 45, reason: { kind: "date", detail: "same" } };
  if (aStart <= bEnd && bStart <= aEnd) return { score: 38, reason: { kind: "date", detail: "overlap" } };
  if (Math.abs(aStart - bStart) <= 3) return { score: 25, reason: { kind: "date", detail: "close" } };
  if (Math.abs(aStart - bStart) <= 31) return { score: 6, reason: { kind: "date", detail: "month" } };
  return { score: 0, reason: null };
}

function recordPeople(rec: SearchableRecord): string[] {
  return [...parseTeachers(rec.teacherNames), ...(rec.guestName ? [rec.guestName] : [])];
}

function teacherScore(
  input: SuggestInput,
  rec: SearchableRecord,
): { score: number; reason: MatchReason | null } {
  const wanted = (input.teacherNames ?? []).filter((n) => fold(n));
  if (wanted.length === 0) return { score: 0, reason: null };
  const people = recordPeople(rec);
  const matched: string[] = [];
  for (const name of wanted) {
    if (people.some((p) => textSimilarity(name, p) >= 0.75)) matched.push(name);
  }
  if (matched.length === 0) return { score: 0, reason: null };
  return {
    score: Math.round(25 * (matched.length / wanted.length)),
    reason: { kind: "teacher", detail: matched.join(", ") },
  };
}

function placeScore(
  input: SuggestInput,
  rec: SearchableRecord,
): { score: number; reason: MatchReason | null } {
  if (!fold(input.placeName) || !fold(rec.place)) return { score: 0, reason: null };
  // The CSV place is "Name, City, Country"; an event place is usually the name.
  const sim = Math.max(
    textSimilarity(input.placeName, rec.place.split(",")[0]),
    textSimilarity(input.placeName, rec.place),
  );
  if (sim < 0.6) return { score: 0, reason: null };
  return { score: Math.round(15 * sim), reason: { kind: "place", detail: rec.place } };
}

/**
 * Rank records as candidates for an event. An exact Wix ID or event code is
 * decisive (score 100); otherwise date overlap (strong), teacher, place and
 * title similarity add up.
 */
export function suggestRecords<T extends SearchableRecord>(
  records: T[],
  input: SuggestInput,
  limit = 8,
): Suggestion<T>[] {
  const code = canonicalCode(input.eventCode);
  const out: Suggestion<T>[] = [];

  for (const record of records) {
    const reasons: MatchReason[] = [];
    if (input.wixId && input.wixId === record.wixId) {
      out.push({ record, score: 100, reasons: [{ kind: "wixId" }] });
      continue;
    }
    if (code && code === canonicalCode(record.eventCode)) {
      out.push({ record, score: 100, reasons: [{ kind: "code" }] });
      continue;
    }

    let score = 0;
    const d = dateScore(input, record);
    const t = teacherScore(input, record);
    const p = placeScore(input, record);
    for (const part of [d, t, p]) {
      score += part.score;
      if (part.reason) reasons.push(part.reason);
    }
    const titleSim = textSimilarity(input.title, record.title);
    if (titleSim >= 0.5) {
      score += Math.round(20 * titleSim);
      reasons.push({ kind: "title", detail: Math.round(titleSim * 100) });
    }
    // A title alone is weak evidence (series share titles); require something more.
    if (score > 0 && reasons.length > 0) out.push({ record, score: Math.min(score, 99), reasons });
  }

  return out
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Mapping a record onto event fields ──────────────────────────────────

export interface RefTeacher { id: number; name: string; abbreviation: string; aliases: string[] }
export interface RefPlace { id: number; name: string; abbreviation: string | null; location: string | null }
export interface RefNamed { id: number; nameEn: string; namePt: string | null }

export interface MappingRef {
  teachers: RefTeacher[];
  places: RefPlace[];
  eventTypes: RefNamed[];
  groups: RefNamed[];
  audiences: RefNamed[];
}

export interface MappedTeacher { id: number; name: string; abbreviation: string; role: "teacher" | "guest" }

/** Event field values a record produces (keys match the admin event form). */
export interface MappingResult {
  wixId: string;
  fields: {
    titlePt: string | null;
    startDate: string | null;
    endDate: string | null;
    mainThemesPt: string | null;
    mainThemesEn: string | null;
    sessionThemesPt: string | null;
    sessionThemesEn: string | null;
    bibliography: string | null;
    organizer: string | null;
    eventTypeId: number | null;
    audienceId: number | null;
    groupIds: number[];
    teacherIds: { id: number; role: "teacher" | "guest" }[];
    placeIds: number[];
    wixId: string;
    librarySnapshot: Record<string, unknown>;
  };
  /** Human-readable names for what the ids resolved to. */
  resolved: {
    eventType: { id: number; nameEn: string; namePt: string | null } | null;
    audience: { id: number; nameEn: string; namePt: string | null } | null;
    groups: { id: number; nameEn: string; namePt: string | null }[];
    teachers: MappedTeacher[];
    places: { id: number; name: string; abbreviation: string | null }[];
  };
  /** CSV values with no matching row yet; created on apply if the admin agrees. */
  unresolved: {
    teachers: { name: string; role: "teacher" | "guest" }[];
    places: string[];
    designation: string | null;
    audience: string | null;
  };
}

function matchNamed<T extends RefNamed>(value: string, list: T[]): T | null {
  const f = fold(value);
  if (!f) return null;
  const exact = list.find((x) => fold(x.namePt) === f || fold(x.nameEn) === f);
  if (exact) return exact;
  // Containment only for real names: an empty name would "contain" everything.
  return (
    list.find((x) =>
      [x.namePt, x.nameEn].some((n) => {
        const nf = fold(n);
        return nf.length >= 4 && f.length >= 4 && (nf.includes(f) || f.includes(nf));
      }),
    ) ?? null
  );
}

export function findTeacher(name: string, teachers: RefTeacher[]): RefTeacher | null {
  const f = fold(name);
  if (!f) return null;
  return (
    teachers.find((t) => fold(t.name) === f) ??
    teachers.find((t) => fold(t.abbreviation) === f || t.aliases.some((a) => fold(a) === f)) ??
    null
  );
}

export function findPlace(location: string, places: RefPlace[]): RefPlace | null {
  const f = fold(location);
  if (!f) return null;
  const short = fold(location.split(",")[0]);
  const shortName = short === "video" ? "online" : short;
  return (
    places.find((p) => fold(p.location) === f || fold(p.name) === f) ??
    places.find((p) => fold(p.name) === shortName) ??
    places.find((p) => p.abbreviation && fold(p.abbreviation) === shortName) ??
    null
  );
}

/** Preview of the event values a record would produce; creates nothing. */
export function mapRecordToEvent(
  record: Pick<LibraryRecordInput, "wixId" | "raw">,
  ref: MappingRef,
  now: Date = new Date(),
): MappingResult {
  const row: WixRow = parseWixRow(record.raw);
  const { startDate, endDate } = parseDateRange(row.dateRange);

  // Designation: an event type when one matches, else a retreat group.
  let eventType: RefNamed | null = null;
  let group: RefNamed | null = null;
  let unresolvedDesignation: string | null = null;
  if (row.designation) {
    eventType = matchNamed(row.designation, ref.eventTypes);
    if (!eventType) {
      const names = designationToGroup(row.designation);
      group = names ? matchNamed(names.namePt, ref.groups) ?? matchNamed(names.nameEn, ref.groups) : null;
    }
    if (!eventType && !group) unresolvedDesignation = row.designation;
  }

  const audience = row.audience ? matchNamed(row.audience, ref.audiences) : null;

  const teacherIds: MappingResult["fields"]["teacherIds"] = [];
  const resolvedTeachers: MappedTeacher[] = [];
  const unresolvedTeachers: MappingResult["unresolved"]["teachers"] = [];
  const people: { name: string; role: "teacher" | "guest" }[] = [
    ...parseTeachers(row.teacherName).map((name) => ({ name, role: "teacher" as const })),
    ...(row.guestName ? [{ name: row.guestName, role: "guest" as const }] : []),
  ];
  for (const person of people) {
    const found = findTeacher(person.name, ref.teachers);
    if (found) {
      if (!teacherIds.some((t) => t.id === found.id)) {
        teacherIds.push({ id: found.id, role: person.role });
        resolvedTeachers.push({ id: found.id, name: found.name, abbreviation: found.abbreviation, role: person.role });
      }
    } else if (!unresolvedTeachers.some((t) => fold(t.name) === fold(person.name))) {
      unresolvedTeachers.push(person);
    }
  }

  const place = row.place ? findPlace(row.place, ref.places) : null;

  const organizations = parseOrganizations(row.organization);
  const snapshot: Record<string, unknown> = {
    source: "library-csv",
    wixId: row.wixId,
    eventCode: row.eventCode || null,
    originalDesignation: record.raw["originalDesignation"]?.trim() || null,
    designation: row.designation || null,
    audience: row.audience || null,
    organizations,
    dateRange: row.dateRange || null,
    place: row.place || null,
    teacherName: row.teacherName || null,
    guestName: row.guestName || null,
    introGuest: record.raw["Aux-introGuest"]?.trim() || null,
    // Wix-side admin notes (they hold Drive links); no event column fits them.
    notes: row.notes || null,
    onOff: row.onOff,
    wixCreatedAt: record.raw["Created Date"]?.trim() || null,
    wixUpdatedAt: record.raw["Updated Date"]?.trim() || null,
    importedAt: now.toISOString(),
  };

  const mainLang = detectLanguage(row.mainThemes, "pt");
  const sessionLang = detectLanguage(row.sessionThemes, "en");

  return {
    wixId: row.wixId,
    fields: {
      titlePt: row.title || null,
      startDate,
      endDate,
      mainThemesPt: mainLang === "pt" ? row.mainThemes || null : null,
      mainThemesEn: mainLang === "en" ? row.mainThemes || null : null,
      sessionThemesPt: sessionLang === "pt" ? row.sessionThemes || null : null,
      sessionThemesEn: sessionLang === "en" ? row.sessionThemes || null : null,
      bibliography: row.bibliography || null,
      organizer: organizations.length > 0 ? organizations.join(", ") : null,
      eventTypeId: eventType?.id ?? null,
      audienceId: audience?.id ?? null,
      groupIds: group ? [group.id] : [],
      teacherIds,
      placeIds: place ? [place.id] : [],
      wixId: row.wixId,
      librarySnapshot: snapshot,
    },
    resolved: {
      eventType,
      audience,
      groups: group ? [group] : [],
      teachers: resolvedTeachers,
      places: place ? [{ id: place.id, name: place.name, abbreviation: place.abbreviation }] : [],
    },
    unresolved: {
      teachers: unresolvedTeachers,
      places: row.place && !place ? [row.place] : [],
      designation: unresolvedDesignation,
      audience: row.audience && !audience ? row.audience : null,
    },
  };
}

const EN_WORDS = new Set(["the", "of", "and", "to", "in", "is", "on", "with", "day", "session", "sessions", "morning", "afternoon", "for", "this"]);
// One-letter words (a, e, o) are left out: "a" is an English word too.
const PT_WORDS = new Set(["de", "da", "do", "das", "dos", "os", "as", "que", "pelo", "pela", "nos", "nas", "para", "em", "com", "um", "uma", "sessao", "sessoes", "dia", "manha", "tarde"]);

/**
 * Guess whether a themes text is English or Portuguese by counting common
 * words. The export mixes both (the session summaries are mostly English, the
 * main themes mostly Portuguese), and a text must land in the matching
 * language field; `fallback` decides ties and word-less text.
 */
export function detectLanguage(text: string, fallback: "en" | "pt"): "en" | "pt" {
  let en = 0;
  let pt = 0;
  for (const w of fold(text).split(" ")) {
    if (EN_WORDS.has(w)) en++;
    if (PT_WORDS.has(w)) pt++;
  }
  return en > pt ? "en" : pt > en ? "pt" : fallback;
}

/** Short name for a new place, the way the seed derived it. */
export function placeNameFromLocation(location: string): string {
  const short = location.split(",")[0]!.trim();
  return short === "Vídeo" ? "Online" : short;
}

/** Initials-based abbreviation for a new teacher; caller ensures uniqueness. */
export function abbreviationFromName(name: string): string {
  const initials = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[\s.,-]+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials || "T";
}
