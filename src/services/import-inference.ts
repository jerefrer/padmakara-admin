import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { importJobs, importFiles } from "../db/schema/index.ts";
import { AppError } from "../lib/errors.ts";
import { config } from "../config.ts";
import {
  parseTrackFilename,
  inferSessions,
  type ParsedTrack,
  type InferredSession,
} from "./track-parser.ts";

/** A single track within a proposed session structure. */
export interface ProposedTrack {
  importFileId: number;
  trackNumber: number;
  title: string;
  speaker: string | null;
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
}

/** A session within a proposed structure. */
export interface ProposedSession {
  sessionNumber: number;
  titleEn: string;
  sessionDate: string | null;
  timePeriod: string;
  tracks: ProposedTrack[];
}

/** The full proposed (or human-confirmed) session structure for an import job. */
export interface ProposedStructure {
  sessions: ProposedSession[];
}

/**
 * Schema for the grouping the AI returns. The AI decides only which audio
 * files go in which session, plus the session metadata — per-track metadata
 * is derived deterministically by the caller, never by the AI.
 */
export const aiGroupingSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionNumber: z.number().int(),
        titleEn: z.string().min(1),
        sessionDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        timePeriod: z.enum(["morning", "afternoon", "evening"]).nullable(),
        importFileIds: z.array(z.number().int()).min(1),
      }),
    )
    .min(1),
});

export type AiGrouping = z.infer<typeof aiGroupingSchema>;

/**
 * Combine the AI's session grouping with deterministic per-track metadata
 * into a full proposed structure. Guarantees referential integrity: throws
 * if the grouping references an unknown file, places a file in more than one
 * session, or omits any file. Sessions are renumbered 1..N in the order the
 * AI returned them; a null session timePeriod defaults to "morning".
 */
export function assembleProposedStructure(
  grouping: AiGrouping,
  tracksByFileId: Map<number, ProposedTrack>,
): ProposedStructure {
  const seen = new Set<number>();

  const sessions: ProposedSession[] = grouping.sessions.map((group, index) => {
    const tracks: ProposedTrack[] = group.importFileIds.map((fileId) => {
      const track = tracksByFileId.get(fileId);
      if (!track) {
        throw new Error(
          `AI grouping references unknown import file id ${fileId}`,
        );
      }
      if (seen.has(fileId)) {
        throw new Error(
          `AI grouping places import file id ${fileId} in more than one session`,
        );
      }
      seen.add(fileId);
      return track;
    });
    return {
      sessionNumber: index + 1,
      titleEn: group.titleEn,
      sessionDate: group.sessionDate,
      timePeriod: group.timePeriod ?? "morning",
      tracks,
    };
  });

  for (const fileId of tracksByFileId.keys()) {
    if (!seen.has(fileId)) {
      throw new Error(`AI grouping omits import file id ${fileId}`);
    }
  }

  return { sessions };
}

// ---------------------------------------------------------------------------
// proposeStructure — the AI-driven session-grouping service
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);

function parsedToProposedTrack(
  parsed: ParsedTrack,
  importFileId: number,
): ProposedTrack {
  return {
    importFileId,
    trackNumber: parsed.trackNumber,
    title: parsed.title,
    speaker: parsed.speaker,
    languages: parsed.languages,
    originalLanguage: parsed.originalLanguage,
    isTranslation: parsed.isTranslation,
  };
}

const GROUPING_SYSTEM_PROMPT = `You organize Buddhist retreat audio recordings into sessions.
A retreat spans one or more days; each day typically has a morning and an afternoon session, sometimes an evening session.
You receive the event code (its leading digits encode the date range, e.g. 20240425_30 means 25-30 April 2024), the list of audio files, and a rule-based first-pass grouping that is often wrong — it frequently dumps every file into a single session.
Return a corrected grouping as a JSON object of exactly this shape:
{"sessions":[{"sessionNumber":1,"titleEn":"...","sessionDate":"YYYY-MM-DD" or null,"timePeriod":"morning"|"afternoon"|"evening" or null,"importFileIds":[...]}]}
Rules:
- Every audio file id must appear exactly once across all sessions — never drop or duplicate an id.
- Within a session, order importFileIds by the leading track number of the filename.
- titleEn is a short human label, e.g. "25 April - Morning".
- Respond with only the JSON object: no prose, no markdown code fences.`;

function buildGroupingPrompt(
  eventCode: string,
  audioFiles: { id: number; filename: string }[],
  seed: InferredSession[],
): string {
  const fileList = audioFiles
    .map((f) => `  id=${f.id}  ${f.filename}`)
    .join("\n");
  const seedText = seed
    .map(
      (s, i) =>
        `  Session ${i + 1} (${s.date ?? "no date"}, ${s.timePeriod ?? "no period"}):\n` +
        s.tracks.map((t) => `    ${t.originalFilename}`).join("\n"),
    )
    .join("\n");
  return [
    `Event code: ${eventCode}`,
    ``,
    `Audio files (id and filename):`,
    fileList,
    ``,
    `Rule-based first-pass grouping (filenames only — map them back to ids):`,
    seedText,
  ].join("\n");
}

/**
 * Use the AI to propose how a cataloged import job's audio files should be
 * grouped into sessions, and store the result on the job. Throws if the job
 * is unknown, has no audio files, or the AI returns an unusable grouping.
 */
export async function proposeStructure(importJobId: number) {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId));
  if (!job) {
    throw AppError.notFound(`Import job ${importJobId} not found`);
  }

  const files = await db
    .select()
    .from(importFiles)
    .where(eq(importFiles.importJobId, importJobId));
  const audioFiles = files.filter((f) =>
    AUDIO_EXTENSIONS.has(f.extension.toLowerCase()),
  );
  if (audioFiles.length === 0) {
    throw AppError.badRequest(
      `Import job ${importJobId} has no audio files to organise`,
      "NO_AUDIO_FILES",
    );
  }

  const parsedByFileId = audioFiles.map((f) => ({
    id: f.id,
    parsed: parseTrackFilename(f.filename),
  }));
  const tracksByFileId = new Map<number, ProposedTrack>(
    parsedByFileId.map((p) => [p.id, parsedToProposedTrack(p.parsed, p.id)]),
  );
  const seed = inferSessions(parsedByFileId.map((p) => p.parsed));

  const userPrompt = buildGroupingPrompt(
    job.eventCode,
    audioFiles.map((f) => ({ id: f.id, filename: f.filename })),
    seed,
  );

  const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 16384,
    system: GROUPING_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("AI returned no text response for session grouping");
  }
  let responseText = textBlock.text.trim();
  if (responseText.startsWith("```")) {
    responseText = responseText
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    throw AppError.internal("AI returned invalid JSON for session grouping");
  }

  const groupingResult = aiGroupingSchema.safeParse(parsedJson);
  if (!groupingResult.success) {
    throw AppError.internal(
      "AI grouping did not match the expected shape",
    );
  }

  let structure: ProposedStructure;
  try {
    structure = assembleProposedStructure(groupingResult.data, tracksByFileId);
  } catch (err) {
    throw AppError.internal(
      `AI grouping failed validation: ${(err as Error).message}`,
    );
  }

  const [updated] = await db
    .update(importJobs)
    .set({
      proposedStructure: structure,
      status: "proposed",
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId))
    .returning();

  return updated!;
}
