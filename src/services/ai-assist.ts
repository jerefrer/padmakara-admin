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

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT =
  'You are helping a Buddhist retreat administrator clean up audio track ' +
  "titles for a content management system. You will receive a list of track " +
  "rows and a plain-English instruction. Apply the instruction to the rows " +
  'and return suggested edits as a JSON array. Each element has "rowKey" ' +
  '(unchanged) and optionally "title" and/or "speaker" with the suggested ' +
  "new values. Only include fields that should change. Return only the JSON " +
  "array, no markdown fences, no prose.";

/** Strip a leading/trailing markdown code fence, if present. */
function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  return t;
}

export async function renameTracks(args: {
  instruction: string;
  rows: RenameTrackRow[];
  roster: RosterTeacher[];
  apiKey: string;
}): Promise<{ suggestions: RenameSuggestion[] }> {
  const { instruction, rows, roster, apiKey } = args;
  const anthropic = new Anthropic({ apiKey });
  const rowsJson = JSON.stringify(rows, null, 2);

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `${SYSTEM_PROMPT}${rosterPromptBlock(roster)}`,
    messages: [
      { role: "user", content: `Instruction: ${instruction}\n\nRows:\n${rowsJson}` },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("No text response from AI API");
  }

  let suggestions: RenameSuggestion[];
  try {
    const raw: unknown = JSON.parse(stripFences(textBlock.text));
    if (!Array.isArray(raw)) throw new Error("Expected array");
    suggestions = raw.map((item: unknown) => {
      if (typeof item !== "object" || item === null) throw new Error("Bad item");
      const s = item as Record<string, unknown>;
      const out: RenameSuggestion = { rowKey: String(s.rowKey ?? "") };
      if (typeof s.title === "string") out.title = s.title;
      if (typeof s.speaker === "string") {
        const resolved = resolveSpeaker(s.speaker, roster);
        out.speaker = resolved.speaker;
        if (resolved.unmatched) out.speakerUnmatched = true;
      }
      return out;
    });
  } catch {
    throw AppError.internal("Failed to parse AI rename response");
  }

  return { suggestions };
}
