/**
 * The diff model behind the AI assistant's "Proposed changes" review table.
 *
 * Kept apart from `AiAssistPanel` so the part that decides *what* the admin is
 * shown — which rows exist, how each item is identified, what order they come
 * in — is plain data in and plain data out, testable without mounting React or
 * standing up react-admin's translation provider.
 */

import { languageLabel } from "./trackParser";

/** Translate function, structurally the one `useTranslate()` hands back. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface AiAssistEventFields {
  titleEn?: string; titlePt?: string;
  mainThemesEn?: string; mainThemesPt?: string;
  sessionThemesEn?: string; sessionThemesPt?: string;
  startDate?: string; endDate?: string;
}

export interface AiAssistSession {
  rowKey: string;
  /** Shown in the review so a retitled session is identifiable — the same
   *  number the session card carries in the track table below the panel. */
  sessionNumber: number;
  titleEn?: string;
  titlePt?: string;
}

export interface AiAssistTrack {
  rowKey: string;
  /** The session this track sits in — groups the review rows. */
  sessionNumber: number;
  /** The track's position within its session, as shown in the track table. */
  trackNumber: number;
  originalFilename: string;
  title: string;
  titleEn?: string;
  titlePt?: string;
  speaker?: string | null;
  languages?: string[];
}

export interface AiAssistVideo {
  rowKey: string;
  /** 0-based, as stored; the review shows it 1-based. */
  position: number;
  title: string;
  titleEn?: string;
  titlePt?: string;
  videoDate?: string;
}

export interface AiAssistResult {
  event?: AiAssistEventFields;
  sessions: Array<{ rowKey: string; titleEn?: string; titlePt?: string }>;
  videos: Array<{ rowKey: string; titleEn?: string; titlePt?: string; videoDate?: string }>;
  tracks: Array<{
    rowKey: string; titleEn?: string; titlePt?: string;
    speaker?: string; speakerUnmatched?: true; languages?: string[];
  }>;
}

/** A run of text within a value, flagged if it differs from the other side. */
export interface Segment {
  text: string;
  changed: boolean;
}

/**
 * Past this many whitespace-separated tokens on either side the word-level
 * comparison is skipped and the whole value is marked changed. The table is
 * re-rendered on every checkbox toggle, and an event-themes field runs to
 * thousands of characters — the quadratic table would be felt.
 */
const MAX_DIFF_TOKENS = 500;

/** Words and the whitespace between them, so the pieces rejoin losslessly. */
const tokenize = (text: string): string[] => text.match(/\s+|\S+/g) ?? [];

/** Append `text` to the trailing segment when it carries the same flag. */
function appendSegment(segments: Segment[], text: string, changed: boolean): void {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

const wholeValue = (text: string): Segment[] => (text ? [{ text, changed: true }] : []);

/**
 * Split both sides into segments with the words they share left unflagged, so
 * the review can show *what* moved inside a title rather than making the admin
 * compare two near-identical sentences by eye.
 *
 * Longest-common-subsequence over tokens, filled backwards so the forward walk
 * that follows can pick the branch with more shared tokens ahead of it.
 */
export function inlineDiff(from: string, to: string): { from: Segment[]; to: Segment[] } {
  const a = tokenize(from);
  const b = tokenize(to);
  if (
    a.length === 0 || b.length === 0 ||
    a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS
  ) {
    return { from: wholeValue(from), to: wholeValue(to) };
  }

  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + (j + 1)]!);
    }
  }

  const fromSegments: Segment[] = [];
  const toSegments: Segment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      appendSegment(fromSegments, a[i]!, false);
      appendSegment(toSegments, b[j]!, false);
      i++; j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + (j + 1)]!) {
      appendSegment(fromSegments, a[i]!, true);
      i++;
    } else {
      appendSegment(toSegments, b[j]!, true);
      j++;
    }
  }
  while (i < a.length) appendSegment(fromSegments, a[i++]!, true);
  while (j < b.length) appendSegment(toSegments, b[j++]!, true);

  return { from: fromSegments, to: toSegments };
}

/** Which group of the reply a row came from, and which key within its item. */
export type DiffKind = "event" | "session" | "video" | "track";

/** One proposed field change — a single row of the review table. */
export interface DiffRow {
  /** Uniquely identifies this change so a checkbox can be tied to it. */
  id: string;
  kind: DiffKind;
  /** The key this row would write on apply, e.g. "titleEn". */
  suggestionKey: string;
  /** Identifies the thing being changed; consecutive rows sharing it are one
   *  group, and only the first of a group repeats the item label. */
  itemKey: string;
  /** Left column, e.g. "03" for a track or "Session 2". Empty for event rows,
   *  which have no item column at all. */
  itemLabel: string;
  /** Small print under `itemLabel` — the item's current name, so a row can be
   *  matched against the table below even when its title is what's changing. */
  itemSubLabel?: string;
  /** Renders a heading row above this item when it differs from the previous
   *  row's — the session a track belongs to. */
  groupLabel?: string;
  field: string;
  from: string;
  to: string;
  /** `from`/`to` split so the words that actually moved can be highlighted. */
  fromSegments: Segment[];
  toSegments: Segment[];
  /** The AI named a speaker that isn't on the event's teacher roster. */
  unmatched?: true;
}

/** "tib" + "en" → "Tibetan + English", the same names the track chips use. */
export const formatLanguages = (codes: string[] | undefined): string =>
  (codes ?? []).map(languageLabel).join(" + ");

/**
 * Event fields in the order the review lists them — titles, then themes, then
 * dates, matching the event form. Iterating this rather than the suggestion's
 * own keys also keeps a field the API doesn't know about out of the table.
 */
const EVENT_FIELD_LABEL_KEYS: Record<keyof AiAssistEventFields, string> = {
  titleEn: "padmakara.events.titleEn",
  titlePt: "padmakara.events.titlePt",
  mainThemesEn: "padmakara.events.mainThemesEn",
  mainThemesPt: "padmakara.events.mainThemesPt",
  sessionThemesEn: "padmakara.events.sessionThemesEn",
  sessionThemesPt: "padmakara.events.sessionThemesPt",
  startDate: "padmakara.events.startDate",
  endDate: "padmakara.events.endDate",
};
const EVENT_FIELD_ORDER = Object.keys(EVENT_FIELD_LABEL_KEYS) as (keyof AiAssistEventFields)[];

/**
 * Append a row unless the suggestion matches what's already there. The model
 * routinely echoes fields it looked at but didn't change, and an
 * "English → English" row per track buries the rows that do change.
 */
function pushRow(
  rows: DiffRow[],
  base: Pick<DiffRow, "kind" | "itemKey" | "itemLabel" | "itemSubLabel" | "groupLabel">,
  suggestionKey: string,
  field: string,
  from: string,
  to: string,
  unmatched?: true,
): void {
  if (from === to) return;
  const segments = inlineDiff(from, to);
  rows.push({
    ...base,
    id: `${base.kind}:${base.itemKey}:${suggestionKey}`,
    suggestionKey,
    field,
    from,
    to,
    fromSegments: segments.from,
    toSegments: segments.to,
    ...(unmatched ? { unmatched } : {}),
  });
}

export function buildEventDiffs(
  current: AiAssistEventFields,
  suggested: AiAssistEventFields | undefined,
  t: Translate,
): DiffRow[] {
  if (!suggested) return [];
  const rows: DiffRow[] = [];
  for (const key of EVENT_FIELD_ORDER) {
    if (suggested[key] === undefined) continue;
    pushRow(
      rows,
      { kind: "event", itemKey: "event", itemLabel: "" },
      key,
      t(EVENT_FIELD_LABEL_KEYS[key]),
      current[key] ?? "",
      suggested[key] ?? "",
    );
  }
  return rows;
}

const sessionLabel = (t: Translate, number: number): string =>
  t("padmakara.session.session", { number });

export function buildSessionDiffs(
  sessions: AiAssistSession[],
  suggestions: AiAssistResult["sessions"],
  t: Translate,
): DiffRow[] {
  const byKey = new Map(sessions.map((s) => [s.rowKey, s]));
  const rows: DiffRow[] = [];
  for (const s of sortByCurrent(suggestions, byKey, (cur) => [cur.sessionNumber])) {
    const cur = byKey.get(s.rowKey);
    const base = {
      kind: "session" as const,
      itemKey: s.rowKey,
      itemLabel: cur ? sessionLabel(t, cur.sessionNumber) : s.rowKey,
    };
    if (s.titleEn !== undefined) pushRow(rows, base, "titleEn", "EN", cur?.titleEn ?? "", s.titleEn);
    if (s.titlePt !== undefined) pushRow(rows, base, "titlePt", "PT", cur?.titlePt ?? "", s.titlePt);
  }
  return rows;
}

export function buildVideoDiffs(
  videos: AiAssistVideo[],
  suggestions: AiAssistResult["videos"],
  t: Translate,
): DiffRow[] {
  const byKey = new Map(videos.map((v) => [v.rowKey, v]));
  const rows: DiffRow[] = [];
  for (const v of sortByCurrent(suggestions, byKey, (cur) => [cur.position])) {
    const cur = byKey.get(v.rowKey);
    const base = {
      kind: "video" as const,
      itemKey: v.rowKey,
      itemLabel: cur
        ? t("padmakara.aiAssist.videoLabel", { number: cur.position + 1 })
        : v.rowKey,
      itemSubLabel: cur?.title,
    };
    if (v.titleEn !== undefined) pushRow(rows, base, "titleEn", "EN", cur?.titleEn ?? "", v.titleEn);
    if (v.titlePt !== undefined) pushRow(rows, base, "titlePt", "PT", cur?.titlePt ?? "", v.titlePt);
    if (v.videoDate !== undefined) {
      pushRow(
        rows, base, "videoDate",
        t("padmakara.aiAssist.videoDate"), cur?.videoDate ?? "", v.videoDate,
      );
    }
  }
  return rows;
}

export function buildTrackDiffs(
  tracks: AiAssistTrack[],
  suggestions: AiAssistResult["tracks"],
  t: Translate,
): DiffRow[] {
  const byKey = new Map(tracks.map((tr) => [tr.rowKey, tr]));
  const rows: DiffRow[] = [];
  for (const tr of sortByCurrent(suggestions, byKey, (cur) => [cur.sessionNumber, cur.trackNumber])) {
    const cur = byKey.get(tr.rowKey);
    const base = {
      kind: "track" as const,
      itemKey: tr.rowKey,
      // Zero-padded to match the number the track table prints on each row.
      itemLabel: cur ? String(cur.trackNumber).padStart(2, "0") : tr.rowKey,
      itemSubLabel: cur?.title || cur?.originalFilename,
      groupLabel: cur ? sessionLabel(t, cur.sessionNumber) : undefined,
    };
    if (tr.titleEn !== undefined) pushRow(rows, base, "titleEn", "EN", cur?.titleEn ?? "", tr.titleEn);
    if (tr.titlePt !== undefined) pushRow(rows, base, "titlePt", "PT", cur?.titlePt ?? "", tr.titlePt);
    if (tr.speaker !== undefined) {
      pushRow(
        rows, base, "speaker",
        t("padmakara.fields.speaker"), cur?.speaker ?? "", tr.speaker, tr.speakerUnmatched,
      );
    }
    if (tr.languages !== undefined) {
      pushRow(
        rows, base, "languages",
        t("padmakara.aiAssist.languages"),
        formatLanguages(cur?.languages),
        formatLanguages(tr.languages),
      );
    }
  }
  return rows;
}

/**
 * Suggestions in the order the admin sees the rows below the panel, rather
 * than the order Claude happened to answer in (which interleaves concurrent
 * batches). Anything whose current row is missing sorts last, keeping the
 * comparator total instead of silently reordering the rest around it.
 */
function sortByCurrent<S extends { rowKey: string }, C>(
  suggestions: S[],
  byKey: Map<string, C>,
  rank: (cur: C) => number[],
): S[] {
  return [...suggestions].sort((a, b) => {
    const ca = byKey.get(a.rowKey);
    const cb = byKey.get(b.rowKey);
    if (!ca || !cb) return (ca ? 0 : 1) - (cb ? 0 : 1);
    const ra = rank(ca);
    const rb = rank(cb);
    for (let i = 0; i < ra.length; i++) {
      // Non-null: rank() returns a fixed-length tuple for a given caller.
      if (ra[i]! !== rb[i]!) return ra[i]! - rb[i]!;
    }
    return 0;
  });
}

/**
 * The reply narrowed to the rows the admin left ticked.
 *
 * Built from the review rows rather than from the reply directly, so what gets
 * applied is exactly what was on screen: a field the model echoed unchanged
 * has no row, therefore no id, therefore never reaches the form. An item left
 * with no fields drops out entirely instead of being applied as an empty
 * patch.
 */
export function selectedResult(
  result: AiAssistResult,
  rows: readonly DiffRow[],
  excluded: ReadonlySet<string>,
): AiAssistResult {
  const allowed = new Set(rows.filter((r) => !excluded.has(r.id)).map((r) => r.id));
  const isOn = (kind: DiffKind, itemKey: string, key: string): boolean =>
    allowed.has(`${kind}:${itemKey}:${key}`);

  let event: AiAssistEventFields | undefined;
  if (result.event) {
    const picked: AiAssistEventFields = {};
    for (const key of EVENT_FIELD_ORDER) {
      const value = result.event[key];
      if (value !== undefined && isOn("event", "event", key)) picked[key] = value;
    }
    if (Object.keys(picked).length) event = picked;
  }

  const sessions = result.sessions.flatMap((s) => {
    const picked: AiAssistResult["sessions"][number] = { rowKey: s.rowKey };
    if (s.titleEn !== undefined && isOn("session", s.rowKey, "titleEn")) picked.titleEn = s.titleEn;
    if (s.titlePt !== undefined && isOn("session", s.rowKey, "titlePt")) picked.titlePt = s.titlePt;
    return Object.keys(picked).length > 1 ? [picked] : [];
  });

  const videos = result.videos.flatMap((v) => {
    const picked: AiAssistResult["videos"][number] = { rowKey: v.rowKey };
    if (v.titleEn !== undefined && isOn("video", v.rowKey, "titleEn")) picked.titleEn = v.titleEn;
    if (v.titlePt !== undefined && isOn("video", v.rowKey, "titlePt")) picked.titlePt = v.titlePt;
    if (v.videoDate !== undefined && isOn("video", v.rowKey, "videoDate")) picked.videoDate = v.videoDate;
    return Object.keys(picked).length > 1 ? [picked] : [];
  });

  const tracks = result.tracks.flatMap((tr) => {
    const picked: AiAssistResult["tracks"][number] = { rowKey: tr.rowKey };
    if (tr.titleEn !== undefined && isOn("track", tr.rowKey, "titleEn")) picked.titleEn = tr.titleEn;
    if (tr.titlePt !== undefined && isOn("track", tr.rowKey, "titlePt")) picked.titlePt = tr.titlePt;
    if (tr.speaker !== undefined && isOn("track", tr.rowKey, "speaker")) {
      picked.speaker = tr.speaker;
      // The warning chip belongs to the speaker; dropping one drops both.
      if (tr.speakerUnmatched) picked.speakerUnmatched = true;
    }
    if (tr.languages !== undefined && isOn("track", tr.rowKey, "languages")) {
      picked.languages = tr.languages;
    }
    return Object.keys(picked).length > 1 ? [picked] : [];
  });

  return { event, sessions, videos, tracks };
}
