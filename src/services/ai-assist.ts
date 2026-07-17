import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../lib/errors.ts";
import {
  resolveSpeaker,
  rosterPromptBlock,
  type RosterTeacher,
} from "./speaker-resolve.ts";

export interface RenameTrackRow {
  rowKey: string;
  originalFilename: string;
  title: string;
  speaker?: string | null;
}

export interface RenameSuggestion {
  rowKey: string;
  title?: string;
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
  '- "tracks": an array of { rowKey, title?, speaker? } for tracks that should ' +
  "change (rowKey unchanged).\n" +
  "IMPORTANT: only suggest changes to event or session fields when the " +
  "instruction explicitly asks about the event or the sessions. If the " +
  "instruction is only about track titles or speakers, return just the " +
  '"tracks" array and leave event/sessions empty. Include only fields that ' +
  "change. Return only the JSON object, no markdown fences, no prose.";

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

  const payload = JSON.stringify({ event: event ?? {}, sessions, tracks }, null, 2);
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${ASSIST_SYSTEM_PROMPT}${rosterPromptBlock(roster)}`,
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
          if (typeof s.title === "string") sug.title = s.title;
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
