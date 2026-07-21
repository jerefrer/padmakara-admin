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
}

export interface RenameSuggestion {
  rowKey: string;
  titleEn?: string;
  titlePt?: string;
  speaker?: string;
  speakerUnmatched?: true;
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

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 8192;

/**
 * Tracks sent per Claude call. A reply costs roughly 70 output tokens per
 * track, so 50 leaves ample headroom under MAX_TOKENS. This batching exists
 * because the earlier single-call design silently truncated its JSON reply
 * (and then failed to parse it) on events with a few hundred tracks.
 */
const TRACK_BATCH_SIZE = 50;

/**
 * Concurrent Claude calls. Keeps a 350-track event to two waves so the whole
 * request finishes well inside the nginx proxy read timeout.
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ASSIST_SYSTEM_PROMPT =
  "You are helping a Buddhist retreat administrator edit a retreat event in a " +
  "content management system. You receive the event's current fields, its " +
  "sessions, its tracks, and a plain-English instruction. Return ONLY a JSON " +
  'object with optional keys "event", "sessions", and "tracks":\n' +
  '- "event": an object with any of titleEn, titlePt, mainThemesEn, mainThemesPt, ' +
  "sessionThemesEn, sessionThemesPt, startDate, endDate — only the fields that " +
  "should change. Dates must be ISO YYYY-MM-DD.\n" +
  '- "sessions": an array of { rowKey, titleEn?, titlePt? } for sessions that ' +
  "should change (rowKey unchanged).\n" +
  '- "tracks": an array of { rowKey, titleEn?, titlePt?, speaker? } for tracks ' +
  "that should change (rowKey unchanged). Each track has titleEn and titlePt " +
  "— the title shown for that interface language, which may be empty — plus " +
  "title, the track's current/original title; for older tracks titleEn and " +
  "titlePt are often both empty and title is the only title filled in " +
  "(usually English). To fill in or translate a track's title, set titleEn " +
  "and/or titlePt (derive the translation from title when titleEn/titlePt " +
  "are empty).\n" +
  "IMPORTANT: only suggest changes to event or session fields when the " +
  "instruction explicitly asks about the event or the sessions. If the " +
  "instruction is only about track titles or speakers, return just the " +
  '"tracks" array and leave event/sessions empty. Include only fields that ' +
  "change. Return only the JSON object, no markdown fences, no prose.";

/**
 * Appended for every batch after the first. Those batches see the event
 * fields purely as translation/naming context — without this note each batch
 * would propose its own competing event title, and only one could survive the
 * merge.
 */
const TRACKS_ONLY_NOTE =
  "\nThis request covers one batch of a longer track list. The event fields " +
  'are shown for context only: return ONLY the "tracks" array, and only for ' +
  "the tracks listed in this batch.";

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
  tracks: RenameTrackRow[];
  roster: RosterTeacher[];
  tracksOnly: boolean;
}): Promise<{ event?: AiEventFields; sessions: AiSessionSuggestion[]; tracks: RenameSuggestion[] }> {
  const { anthropic, instruction, event, sessions, tracks, roster, tracksOnly } = args;

  const payload = JSON.stringify({ event: event ?? {}, sessions, tracks }, null, 2);
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: `${ASSIST_SYSTEM_PROMPT}${tracksOnly ? TRACKS_ONLY_NOTE : ""}${rosterPromptBlock(roster)}`,
    messages: [
      { role: "user", content: `Instruction: ${instruction}\n\nCurrent data:\n${payload}` },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  try {
    const raw: unknown = JSON.parse(stripFences(textBlock.text));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Expected object");
    }
    const r = raw as Record<string, unknown>;

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

    const outTracks: RenameSuggestion[] = Array.isArray(r.tracks)
      ? r.tracks.flatMap((item): RenameSuggestion[] => {
          if (typeof item !== "object" || item === null) return [];
          const s = item as Record<string, unknown>;
          const sug: RenameSuggestion = { rowKey: String(s.rowKey ?? "") };
          if (typeof s.titleEn === "string") sug.titleEn = s.titleEn;
          if (typeof s.titlePt === "string") sug.titlePt = s.titlePt;
          if (typeof s.speaker === "string") {
            const resolved = resolveSpeaker(s.speaker, roster);
            sug.speaker = resolved.speaker;
            if (resolved.unmatched) sug.speakerUnmatched = true;
          }
          return sug.rowKey ? [sug] : [];
        })
      : [];

    return { event: outEvent, sessions: outSessions, tracks: outTracks };
  } catch {
    throw AppError.internal("Failed to parse AI assist response");
  }
}

export async function aiAssistEvent(args: {
  instruction: string;
  event?: AiEventFields;
  sessions?: AiSessionRow[];
  tracks: RenameTrackRow[];
  roster: RosterTeacher[];
  apiKey: string;
}): Promise<{ event?: AiEventFields; sessions: AiSessionSuggestion[]; tracks: RenameSuggestion[] }> {
  const { instruction, event, sessions = [], tracks, roster, apiKey } = args;
  const anthropic = new Anthropic({ apiKey });

  const batches: RenameTrackRow[][] = [];
  for (let i = 0; i < tracks.length; i += TRACK_BATCH_SIZE) {
    batches.push(tracks.slice(i, i + TRACK_BATCH_SIZE));
  }
  // An empty track list still warrants one call: the instruction may target
  // only the event or session fields.
  if (batches.length === 0) batches.push([]);

  const results = await mapWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch, i) =>
    runAssistBatch({
      anthropic,
      instruction,
      roster,
      // The event fields are context for every batch (they inform titles and
      // translations), but only the first batch is allowed to change them.
      event,
      sessions: i === 0 ? sessions : [],
      tracks: batch,
      tracksOnly: i > 0,
    }),
  );

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

  return {
    event: results[0]?.event,
    sessions: results[0]?.sessions ?? [],
    tracks: outTracks,
  };
}
