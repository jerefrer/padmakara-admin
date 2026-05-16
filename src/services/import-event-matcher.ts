/**
 * Pure helpers for deriving event metadata from a legacy Padmakara event code
 * and its source folder name.
 *
 * Legacy codes are inconsistent: across the 232 events being re-imported the
 * date prefix appears in ~10 shapes — compact `YYYYMMDD`, dashed `YYYY-MM-DD`,
 * same-month (`_DD`) and cross-month (`_MMDD`) ranges, month-only `YYYYMM`,
 * `YYYYMM00` with an unknown day, and a pipe-separated multi-month span — plus
 * a few malformed ones. Everything here is best-effort: whatever cannot be
 * decoded is reported as `null` / `"none"` and left for the admin to fill in
 * on the import review screen.
 */

export type DateConfidence = "day" | "month" | "none";

export interface ParsedEventCode {
  /** Best-effort `YYYY-MM-DD` start date, or null when undecodable. */
  startDate: string | null;
  /** Best-effort `YYYY-MM-DD` end date, or null (single day / undecodable). */
  endDate: string | null;
  /**
   * `"day"` — exact day(s) decoded; `"month"` — only the month is known and
   * the day was defaulted to `01`; `"none"` — no usable date.
   */
  dateConfidence: DateConfidence;
  /**
   * The `-`-separated abbreviation tokens after the date (teacher / event-type
   * / group / place codes), trimmed and upper-cased.
   */
  tokens: string[];
}

/** A chunk made only of digits and the separators that appear inside a legacy
 *  date blob (`_` ranges, `|`/`:` multi-month spans). */
function isDateChunk(chunk: string): boolean {
  return /^[0-9_|:]+$/.test(chunk);
}

function validMonth(mm: string): boolean {
  const n = Number(mm);
  return n >= 1 && n <= 12;
}

function validDay(dd: string): boolean {
  const n = Number(dd);
  return n >= 1 && n <= 31;
}

const NO_DATE = {
  startDate: null,
  endDate: null,
  dateConfidence: "none" as const,
};

/** Decode the date-only portion of an event code (dashes already stripped). */
function parseDateBlob(blob: string): {
  startDate: string | null;
  endDate: string | null;
  dateConfidence: DateConfidence;
} {
  if (!blob) return NO_DATE;

  // Pipe / colon multi-month span: YYYYMM then more MM, e.g. 200402|03|04.
  if (/[|:]/.test(blob)) {
    const parts = blob.split(/[|:]/);
    const head = /^(\d{4})(\d{2})$/.exec(parts[0] ?? "");
    const lastMonth = parts[parts.length - 1] ?? "";
    if (!head || !/^\d{2}$/.test(lastMonth)) return NO_DATE;
    const [, year, firstMonth] = head;
    if (!validMonth(firstMonth!) || !validMonth(lastMonth)) return NO_DATE;
    return {
      startDate: `${year}-${firstMonth}-01`,
      endDate: `${year}-${lastMonth}-01`,
      dateConfidence: "month",
    };
  }

  // Range: <8-digit date>_<DD | MMDD>.
  const underscore = blob.indexOf("_");
  if (underscore >= 0) {
    const head = /^(\d{4})(\d{2})(\d{2})$/.exec(blob.slice(0, underscore));
    const tail = blob.slice(underscore + 1);
    if (!head) return NO_DATE;
    const [, year, month, day] = head;
    if (!validMonth(month!)) return NO_DATE;
    // An unknown start day (00) collapses the whole thing to month precision.
    if (day === "00") {
      return { startDate: `${year}-${month}-01`, endDate: null, dateConfidence: "month" };
    }
    if (!validDay(day!)) return NO_DATE;
    const startDate = `${year}-${month}-${day}`;
    if (/^\d{2}$/.test(tail) && validDay(tail)) {
      return { startDate, endDate: `${year}-${month}-${tail}`, dateConfidence: "day" };
    }
    if (/^\d{4}$/.test(tail)) {
      const endMonth = tail.slice(0, 2);
      const endDay = tail.slice(2);
      if (validMonth(endMonth) && validDay(endDay)) {
        return {
          startDate,
          endDate: `${year}-${endMonth}-${endDay}`,
          dateConfidence: "day",
        };
      }
    }
    return NO_DATE;
  }

  // Compact single date: YYYYMMDD (day 00 → month precision).
  const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(blob);
  if (ymd) {
    const [, year, month, day] = ymd;
    if (!validMonth(month!)) return NO_DATE;
    if (day === "00") {
      return { startDate: `${year}-${month}-01`, endDate: null, dateConfidence: "month" };
    }
    if (!validDay(day!)) return NO_DATE;
    const date = `${year}-${month}-${day}`;
    return { startDate: date, endDate: date, dateConfidence: "day" };
  }

  // Month only: YYYYMM.
  const ym = /^(\d{4})(\d{2})$/.exec(blob);
  if (ym) {
    const [, year, month] = ym;
    if (!validMonth(month!)) return NO_DATE;
    return { startDate: `${year}-${month}-01`, endDate: null, dateConfidence: "month" };
  }

  return NO_DATE;
}

/**
 * Parse a Padmakara event code into a date range and the list of abbreviation
 * tokens that follow the date. The date blob may itself contain `-` (dashed
 * dates), so the date is taken as the leading run of digit-only chunks and the
 * first chunk containing a letter starts the tokens.
 */
export function parseEventCode(code: string): ParsedEventCode {
  const chunks = code
    .split("-")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const dateChunks: string[] = [];
  let i = 0;
  while (i < chunks.length && isDateChunk(chunks[i]!)) {
    dateChunks.push(chunks[i]!);
    i += 1;
  }
  const tokens = chunks.slice(i).map((t) => t.toUpperCase());
  // Date chunks are joined with nothing — any `-` between them was structural.
  const { startDate, endDate, dateConfidence } = parseDateBlob(dateChunks.join(""));
  return { startDate, endDate, dateConfidence, tokens };
}

interface AbbrevEntity {
  id: number;
  abbreviation: string | null;
}

export interface EventCodeLookups {
  teachers: AbbrevEntity[];
  eventTypes: AbbrevEntity[];
  groups: AbbrevEntity[];
  places: AbbrevEntity[];
  /** Audiences carry no abbreviation — matched by name for the parallel-retreat default. */
  audiences: { id: number; nameEn: string }[];
}

export interface MatchedEventEntities {
  teacherIds: number[];
  groupIds: number[];
  placeIds: number[];
  eventTypeId: number | null;
  audienceId: number | null;
}

/** Abbreviation of the "Parallel Retreats" event type. */
const PARALLEL_RETREAT_TYPE_ABBREV = "RET";
/** Name of the audience defaulted for parallel retreats. */
const RETREAT_GROUP_MEMBERS_AUDIENCE = "retreat group members";

/**
 * Match event-code tokens against DB lookup lists by abbreviation. A token is
 * compared (case-insensitively) to every list; multiple teachers/groups/places
 * may match, but only the first event type is kept (an event has one type).
 * Tokens that match nothing are dropped — the admin fills those by hand.
 *
 * Parallel-retreat inference: a parallel retreat encodes its group(s) in the
 * code in place of the "RET" event-type marker (e.g. `...-TM1-...` for the
 * Mind Training 1 group). So when a group matched but no event type did, the
 * event IS a parallel retreat — we infer the "RET" event type. And whenever
 * the event type is "RET", the audience defaults to retreat-group members.
 * This mirrors the legacy folder-import detection.
 */
export function matchEventCodeTokens(
  tokens: string[],
  lookups: EventCodeLookups,
): MatchedEventEntities {
  const indexByAbbrev = (list: AbbrevEntity[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const entity of list) {
      if (entity.abbreviation) {
        map.set(entity.abbreviation.toUpperCase(), entity.id);
      }
    }
    return map;
  };
  const teacherMap = indexByAbbrev(lookups.teachers);
  const typeMap = indexByAbbrev(lookups.eventTypes);
  const groupMap = indexByAbbrev(lookups.groups);
  const placeMap = indexByAbbrev(lookups.places);

  const result: MatchedEventEntities = {
    teacherIds: [],
    groupIds: [],
    placeIds: [],
    eventTypeId: null,
    audienceId: null,
  };
  for (const raw of tokens) {
    const token = raw.toUpperCase();
    const teacherId = teacherMap.get(token);
    if (teacherId !== undefined) result.teacherIds.push(teacherId);
    const groupId = groupMap.get(token);
    if (groupId !== undefined) result.groupIds.push(groupId);
    const placeId = placeMap.get(token);
    if (placeId !== undefined) result.placeIds.push(placeId);
    const typeId = typeMap.get(token);
    if (typeId !== undefined && result.eventTypeId === null) {
      result.eventTypeId = typeId;
    }
  }

  // Parallel-retreat inference: a matched group with no matched event type
  // means the code used the group in place of the "RET" marker.
  const retType = lookups.eventTypes.find(
    (t) => t.abbreviation?.toUpperCase() === PARALLEL_RETREAT_TYPE_ABBREV,
  );
  if (result.groupIds.length > 0 && result.eventTypeId === null && retType) {
    result.eventTypeId = retType.id;
  }
  // Whenever the event is a parallel retreat, default the audience.
  if (retType && result.eventTypeId === retType.id) {
    const groupMembers = lookups.audiences.find(
      (a) => a.nameEn.toLowerCase() === RETREAT_GROUP_MEMBERS_AUDIENCE,
    );
    if (groupMembers) result.audienceId = groupMembers.id;
  }

  return result;
}

/**
 * Extract a human-readable title hint from a legacy folder name — the text
 * inside the first parenthesis, e.g. `".../...-CCA (Amala Parinirvana)/"` →
 * `"Amala Parinirvana"`. Returns null when there is no such hint (the common
 * case — only a couple of legacy folders carry one).
 */
export function extractFolderTitle(folderName: string): string | null {
  const match = /\(([^)]+)\)/.exec(folderName);
  const title = match?.[1]?.trim();
  return title && title.length > 0 ? title : null;
}
