import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../lib/errors.ts";
import { mapWithConcurrency } from "../lib/concurrency.ts";
import {
  resolveSpeaker,
  rosterPromptBlock,
  type RosterTeacher,
} from "./speaker-resolve.ts";

export interface RenameTrackRow {
  rowKey: string;
  originalFilename: string;
  title: string;
  titleEn?: string;
  titlePt?: string;
  speaker?: string | null;
  languages?: string[];
}

export interface RenameSuggestion {
  rowKey: string;
  titleEn?: string;
  titlePt?: string;
  speaker?: string;
  speakerUnmatched?: true;
  languages?: string[];
}

export interface AiEventFields {
  titleEn?: string;
  titlePt?: string;
  mainThemesEn?: string;
  mainThemesPt?: string;
  sessionThemesEn?: string;
  sessionThemesPt?: string;
  startDate?: string;
  endDate?: string;
}

export interface AiSessionRow {
  rowKey: string;
  titleEn?: string;
  titlePt?: string;
}

export interface AiSessionSuggestion {
  rowKey: string;
  titleEn?: string;
  titlePt?: string;
}

/**
 * An event video (an `event_videos` row), which is a separate entity from an
 * audio track: it hangs off the event rather than a session, and carries a
 * recording date of its own.
 */
export interface AiVideoRow {
  rowKey: string;
  title: string;
  titleEn?: string;
  titlePt?: string;
  videoDate?: string;
}

export interface AiVideoSuggestion {
  rowKey: string;
  titleEn?: string;
  titlePt?: string;
  videoDate?: string;
}

const MODEL = "claude-opus-5";

/**
 * Thinking is on by default on Opus 5 and counts against `max_tokens`
 * alongside the JSON reply, so this is well above what the reply alone needs
 * (see TRACK_BATCH_SIZE). Kept at the non-streaming ceiling that stays
 * comfortably inside the SDK's HTTP timeout.
 */
const MAX_TOKENS = 16000;

/**
 * Renaming and translating from a filled-in payload is structured work, not
 * deep reasoning — `medium` is the cost/latency lever that keeps a multi-batch
 * event responsive without costing the translation quality that motivated the
 * move off Haiku.
 */
const EFFORT = "medium" as const;

/**
 * Retries the Anthropic SDK performs on transient failures (5xx, 429, network)
 * before giving up, on top of its default of 2. The upstream API occasionally
 * returns a bare 500 `api_error`; a couple of extra attempts smooths over the
 * momentary ones.
 */
const AI_MAX_RETRIES = 4;

/**
 * True for errors worth retrying / worth telling the admin to retry: an
 * Anthropic upstream 5xx, a rate limit (429), or a connection error (which
 * surfaces without a numeric status). Duck-typed on `.status`/`.name` so it
 * holds without importing the SDK's error classes.
 */
function isTransientUpstreamError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; name?: unknown };
  if (typeof e.status === "number") return e.status >= 500 || e.status === 429;
  return typeof e.name === "string" && /Connection|Timeout/i.test(e.name);
}

/**
 * Tracks sent per Claude call. A reply costs roughly 70 output tokens per
 * track, so 50 leaves ample headroom under MAX_TOKENS even once thinking is
 * accounted for. This batching exists because the earlier single-call design
 * silently truncated its JSON reply (and then failed to parse it) on events
 * with a few hundred tracks.
 */
const TRACK_BATCH_SIZE = 50;

/**
 * Concurrent Claude calls. Keeps a 350-track event to two waves, which matters
 * more on Opus than it did on Haiku: the wall clock is the admin staring at a
 * spinner, not a proxy timeout (Caddy sets no response read timeout).
 */
const MAX_CONCURRENT_BATCHES = 6;

/** Strip a leading/trailing markdown code fence, if present. */
function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  return t;
}

/**
 * The first balanced top-level JSON object in `text`, or null if there is
 * none. Claude sometimes prefaces (or follows) its JSON with a sentence of
 * prose, which a whole-string `JSON.parse` chokes on even though the object
 * itself is perfectly good. String literals are tracked so a brace inside a
 * title doesn't close the object early.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** How much of Claude's prose reply to quote back to the admin. */
const CLARIFICATION_MAX_CHARS = 600;

/**
 * Turn a reply that carries no JSON at all into an admin-facing message. This
 * is nearly always Claude asking a clarifying question — an instruction that
 * names data it wasn't given, say — so quoting it verbatim tells the admin
 * exactly what to fix, where the old generic parse error told them nothing.
 */
function clarificationError(text: string): AppError {
  const said = text.replace(/\s+/g, " ").trim();
  if (!said) {
    return new AppError(
      422,
      "The AI assistant returned an empty response. Please try again.",
      "AI_NEEDS_CLARIFICATION",
    );
  }
  const quoted =
    said.length > CLARIFICATION_MAX_CHARS
      ? `${said.slice(0, CLARIFICATION_MAX_CHARS)}…`
      : said;
  return new AppError(
    422,
    `The AI assistant did not propose any changes and replied instead: “${quoted}” — rephrase the instruction and try again.`,
    "AI_NEEDS_CLARIFICATION",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a reply into its JSON object, tolerating fences and surrounding prose.
 * Throws a 422 carrying Claude's own words when there is no object to find.
 *
 * The embedded-object search runs only when the reply isn't valid JSON at all,
 * i.e. when it is wrapped in prose. A reply that parses cleanly but has the
 * wrong shape (an array of suggestions rather than the object) is a formatting
 * failure: fishing the first nested object out of it would yield a fragment
 * and report "no changes proposed", which reads as success.
 */
function parseAssistReply(text: string): Record<string, unknown> {
  const stripped = stripFences(text);
  let whole: unknown;
  try {
    whole = JSON.parse(stripped);
  } catch {
    const embedded = extractJsonObject(stripped);
    if (embedded) {
      try {
        const parsed: unknown = JSON.parse(embedded);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        // Not JSON after all — fall through to the clarification error.
      }
    }
    throw clarificationError(stripped);
  }
  if (isPlainObject(whole)) return whole;
  throw clarificationError(stripped);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The language codes a track may carry, in the canonical order they are
 * stored in — `originalLanguage` is the first entry, so the order is data,
 * not presentation. Mirrors LANGUAGE_MAP in track-parser.ts and
 * LANGUAGE_CODES / LANG_PRIORITY in the admin track table: a code outside
 * this list has no chip, no label and no filename round-trip, so a suggestion
 * carrying one is dropped rather than written to the row.
 */
const TRACK_LANGUAGES = ["tib", "en", "pt", "fr"] as const;

/**
 * A suggested language list reduced to what we can actually store:
 * lowercased, unrecognized codes dropped, de-duplicated, and put back in
 * canonical order. Returns undefined when nothing recognizable is left —
 * an empty list would strip the track of every language, which is worse than
 * leaving it alone.
 */
function cleanLanguages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const codes = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const code = item.trim().toLowerCase();
    if ((TRACK_LANGUAGES as readonly string[]).includes(code)) codes.add(code);
  }
  const out = TRACK_LANGUAGES.filter((code) => codes.has(code));
  return out.length ? [...out] : undefined;
}

const sameLanguages = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((code, i) => code === b[i]);

const ASSIST_SYSTEM_PROMPT =
  "You are helping a Buddhist retreat administrator edit a retreat event in a " +
  "content management system. You receive the event's current fields, its " +
  "sessions, its videos, its tracks, and a plain-English instruction. Return " +
  'ONLY a JSON object with optional keys "event", "sessions", "videos", and ' +
  '"tracks":\n' +
  '- "event": an object with any of titleEn, titlePt, mainThemesEn, mainThemesPt, ' +
  "sessionThemesEn, sessionThemesPt, startDate, endDate — only the fields that " +
  "should change. Dates must be ISO YYYY-MM-DD.\n" +
  '- "sessions": an array of { rowKey, titleEn?, titlePt? } for sessions that ' +
  "should change (rowKey unchanged).\n" +
  '- "videos": an array of { rowKey, titleEn?, titlePt?, videoDate? } for ' +
  "videos that should change (rowKey unchanged). Videos are recordings " +
  "attached to the event itself, separate from the audio tracks. Each has " +
  "titleEn and titlePt (either may be empty), title — its current title, " +
  "which is often still the raw upload filename — and videoDate, the " +
  "recording date, which may be empty. Set titleEn/titlePt to give a video a " +
  "readable title, and videoDate (ISO YYYY-MM-DD) when the instruction asks " +
  "for a date or one can be derived from the name. Correct an obviously " +
  "mistyped year in a filename (a 5-digit year, for instance) to the year it " +
  "plainly means.\n" +
  '- "tracks": an array of { rowKey, titleEn?, titlePt?, speaker?, languages? } ' +
  "for tracks that should change (rowKey unchanged). Each track has titleEn " +
  "and titlePt — the title shown for that interface language, which may be " +
  "empty — plus title, the track's current/original title; for older tracks " +
  "titleEn and titlePt are often both empty and title is the only title " +
  "filled in (usually English). To fill in or translate a track's title, set " +
  "titleEn and/or titlePt (derive the translation from title when " +
  "titleEn/titlePt are empty). Each track also has languages — the languages " +
  "actually spoken in that recording, as an array of codes, exactly one of " +
  '"tib" (Tibetan), "en" (English), "pt" (Portuguese), "fr" (French) per ' +
  "entry; no other code exists. Setting languages REPLACES the whole list, so " +
  "list every language the track should end up with, in the order tib, en, " +
  "pt, fr. Omit languages for a track whose list is already correct.\n" +
  "IMPORTANT: only suggest changes to a group when the instruction asks about " +
  "that group. An instruction about videos changes only videos; one about " +
  "track titles or speakers changes only tracks; leave every other key out. " +
  "Include only fields that change. If the instruction names data that is not " +
  "in the payload, return an empty JSON object rather than acting on the " +
  "nearest similar rows. Return only the JSON object, no markdown fences, no " +
  "prose.";

/**
 * Appended for every batch after the first. Those batches see the event
 * fields purely as translation/naming context — without this note each batch
 * would propose its own competing event title, and only one could survive the
 * merge.
 */
const TRACKS_ONLY_NOTE =
  "\nThis request covers one batch of a longer track list. The event fields " +
  'are shown for context only: return ONLY the "tracks" array, and only for ' +
  "the tracks listed in this batch. The sessions and videos are handled by " +
  "another request — omit those keys entirely.";

function cleanEvent(raw: unknown): AiEventFields | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  const out: AiEventFields = {};
  for (const k of ["titleEn", "titlePt", "mainThemesEn", "mainThemesPt", "sessionThemesEn", "sessionThemesPt"] as const) {
    if (typeof s[k] === "string") out[k] = s[k] as string;
  }
  for (const k of ["startDate", "endDate"] as const) {
    if (typeof s[k] === "string" && ISO_DATE.test(s[k] as string)) out[k] = s[k] as string;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One Claude call over a single batch of tracks. */
async function runAssistBatch(args: {
  anthropic: Anthropic;
  instruction: string;
  event?: AiEventFields;
  sessions: AiSessionRow[];
  videos: AiVideoRow[];
  tracks: RenameTrackRow[];
  roster: RosterTeacher[];
  tracksOnly: boolean;
}): Promise<{
  event?: AiEventFields;
  sessions: AiSessionSuggestion[];
  videos: AiVideoSuggestion[];
  tracks: RenameSuggestion[];
}> {
  const { anthropic, instruction, event, sessions, videos, tracks, roster, tracksOnly } = args;

  const payload = JSON.stringify({ event: event ?? {}, sessions, videos, tracks }, null, 2);
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system: `${ASSIST_SYSTEM_PROMPT}${tracksOnly ? TRACKS_ONLY_NOTE : ""}${rosterPromptBlock(roster)}`,
    messages: [
      { role: "user", content: `Instruction: ${instruction}\n\nCurrent data:\n${payload}` },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  const r = parseAssistReply(textBlock.text);

  const outEvent = cleanEvent(r.event);

  const outSessions: AiSessionSuggestion[] = Array.isArray(r.sessions)
    ? r.sessions.flatMap((item): AiSessionSuggestion[] => {
        if (typeof item !== "object" || item === null) return [];
        const s = item as Record<string, unknown>;
        const sug: AiSessionSuggestion = { rowKey: String(s.rowKey ?? "") };
        if (typeof s.titleEn === "string") sug.titleEn = s.titleEn;
        if (typeof s.titlePt === "string") sug.titlePt = s.titlePt;
        return sug.rowKey ? [sug] : [];
      })
    : [];

  const outVideos: AiVideoSuggestion[] = Array.isArray(r.videos)
    ? r.videos.flatMap((item): AiVideoSuggestion[] => {
        if (typeof item !== "object" || item === null) return [];
        const s = item as Record<string, unknown>;
        const sug: AiVideoSuggestion = { rowKey: String(s.rowKey ?? "") };
        if (typeof s.titleEn === "string") sug.titleEn = s.titleEn;
        if (typeof s.titlePt === "string") sug.titlePt = s.titlePt;
        // Same rule as the event dates: a date the API can't store is worse
        // than no suggestion, so anything non-ISO is dropped rather than
        // handed to the admin as an applyable change.
        if (typeof s.videoDate === "string" && ISO_DATE.test(s.videoDate)) {
          sug.videoDate = s.videoDate;
        }
        // A bare rowKey with nothing changed is noise in the review table.
        return sug.rowKey && Object.keys(sug).length > 1 ? [sug] : [];
      })
    : [];

  // The rows this batch was given, to measure a suggested language list
  // against the one the track already has.
  const currentByKey = new Map(tracks.map((t) => [t.rowKey, t]));

  const outTracks: RenameSuggestion[] = Array.isArray(r.tracks)
    ? r.tracks.flatMap((item): RenameSuggestion[] => {
        if (typeof item !== "object" || item === null) return [];
        const s = item as Record<string, unknown>;
        const sug: RenameSuggestion = { rowKey: String(s.rowKey ?? "") };
        if (typeof s.titleEn === "string") sug.titleEn = s.titleEn;
        if (typeof s.titlePt === "string") sug.titlePt = s.titlePt;
        if (s.languages !== undefined) {
          const langs = cleanLanguages(s.languages);
          const current = currentByKey.get(sug.rowKey)?.languages;
          // A list identical to the track's own is not a change. Instructions
          // that name languages tend to make the model echo every track it
          // looked at, which would otherwise draw an "English → English" row
          // per track and bury the tracks that do change.
          if (langs && !(current && sameLanguages(current, langs))) {
            sug.languages = langs;
          }
        }
        if (typeof s.speaker === "string") {
          const resolved = resolveSpeaker(s.speaker, roster);
          sug.speaker = resolved.speaker;
          if (resolved.unmatched) sug.speakerUnmatched = true;
        }
        return sug.rowKey ? [sug] : [];
      })
    : [];

  return { event: outEvent, sessions: outSessions, videos: outVideos, tracks: outTracks };
}

export async function aiAssistEvent(args: {
  instruction: string;
  event?: AiEventFields;
  sessions?: AiSessionRow[];
  videos?: AiVideoRow[];
  tracks: RenameTrackRow[];
  roster: RosterTeacher[];
  apiKey: string;
}): Promise<{
  event?: AiEventFields;
  sessions: AiSessionSuggestion[];
  videos: AiVideoSuggestion[];
  tracks: RenameSuggestion[];
}> {
  const { instruction, event, sessions = [], videos = [], tracks, roster, apiKey } = args;
  const anthropic = new Anthropic({ apiKey, maxRetries: AI_MAX_RETRIES });

  const batches: RenameTrackRow[][] = [];
  for (let i = 0; i < tracks.length; i += TRACK_BATCH_SIZE) {
    batches.push(tracks.slice(i, i + TRACK_BATCH_SIZE));
  }
  // An empty track list still warrants one call: the instruction may target
  // only the event, session, or video fields.
  if (batches.length === 0) batches.push([]);

  let results;
  try {
    results = await mapWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch, i) =>
      runAssistBatch({
        anthropic,
        instruction,
        roster,
        // The event fields are context for every batch (they inform titles and
        // translations), but only the first batch is allowed to change them.
        event,
        // Sessions and videos are event-wide, not per-batch: sending them once
        // keeps the batches from proposing competing edits to the same rows.
        sessions: i === 0 ? sessions : [],
        videos: i === 0 ? videos : [],
        tracks: batch,
        tracksOnly: i > 0,
      }),
    );
  } catch (err) {
    // Parse / no-text failures are already AppErrors — let them through as-is.
    if (err instanceof AppError) throw err;
    // A transient upstream failure (the SDK's retries already exhausted) is
    // surfaced as a clear, retryable 503 rather than the bare 500 the raw SDK
    // error would produce — so the admin retries instead of assuming the
    // feature is broken.
    if (isTransientUpstreamError(err)) {
      throw new AppError(
        503,
        "The AI assistant is temporarily unavailable (upstream error). Please try again in a moment.",
        "AI_UNAVAILABLE",
      );
    }
    throw err;
  }

  // Merge track suggestions, keeping each batch to the rows it was actually
  // given: a batch that echoes a rowKey from another batch would otherwise
  // overwrite that batch's own, better-informed suggestion.
  const outTracks: RenameSuggestion[] = [];
  const seen = new Set<string>();
  results.forEach((result, i) => {
    // Non-null: results is index-aligned with batches by mapWithConcurrency.
    const allowed = new Set(batches[i]!.map((t) => t.rowKey));
    for (const suggestion of result.tracks) {
      if (!allowed.has(suggestion.rowKey) || seen.has(suggestion.rowKey)) continue;
      seen.add(suggestion.rowKey);
      outTracks.push(suggestion);
    }
  });

  // Only the first batch was given the sessions and videos, so only its reply
  // can carry suggestions for them; a later batch echoing one is discarded.
  const allowedVideoKeys = new Set(videos.map((v) => v.rowKey));
  return {
    event: results[0]?.event,
    sessions: results[0]?.sessions ?? [],
    videos: (results[0]?.videos ?? []).filter((v) => allowedVideoKeys.has(v.rowKey)),
    tracks: outTracks,
  };
}
