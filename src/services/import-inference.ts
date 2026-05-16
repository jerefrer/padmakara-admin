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
  originalFilename: string;
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
 * Schema for the grouping the AI returns. The AI decides which audio files go
 * in which session and supplies a cleaned title for each track — all other
 * per-track metadata is derived deterministically by the caller.
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
        tracks: z
          .array(
            z.object({
              importFileId: z.number().int(),
              title: z.string().min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type AiGrouping = z.infer<typeof aiGroupingSchema>;

/** Schema for a full ProposedStructure — used to validate a human-confirmed structure. */
export const proposedStructureSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionNumber: z.number().int(),
        titleEn: z.string().min(1),
        sessionDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        timePeriod: z.string().min(1),
        tracks: z
          .array(
            z.object({
              importFileId: z.number().int(),
              trackNumber: z.number().int(),
              title: z.string(),
              speaker: z.string().nullable(),
              languages: z.array(z.string()),
              originalLanguage: z.string(),
              isTranslation: z.boolean(),
              originalFilename: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

/**
 * Combine the AI's session grouping (which now also carries per-track cleaned
 * titles) with deterministic per-track metadata into a full proposed structure.
 * Guarantees referential integrity: throws if the grouping references an
 * unknown file, places a file in more than one session, or omits any file.
 * Sessions are renumbered 1..N in the order the AI returned them; a null
 * session timePeriod defaults to "morning".
 */
export function assembleProposedStructure(
  grouping: AiGrouping,
  tracksByFileId: Map<number, ProposedTrack>,
): ProposedStructure {
  const seen = new Set<number>();

  const sessions: ProposedSession[] = grouping.sessions.map((group, index) => {
    const tracks: ProposedTrack[] = group.tracks.map((aiTrack) => {
      const base = tracksByFileId.get(aiTrack.importFileId);
      if (!base) {
        throw new Error(
          `AI grouping references unknown import file id ${aiTrack.importFileId}`,
        );
      }
      if (seen.has(aiTrack.importFileId)) {
        throw new Error(
          `AI grouping places import file id ${aiTrack.importFileId} in more than one session`,
        );
      }
      seen.add(aiTrack.importFileId);
      // The AI supplies a cleaned title; all other per-track metadata stays
      // deterministic (from parseTrackFilename).
      return { ...base, title: aiTrack.title };
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
const PROPOSABLE_STATUSES = new Set(["cataloged", "proposed"]);

function parsedToProposedTrack(
  parsed: ParsedTrack,
  importFileId: number,
): ProposedTrack {
  // ParsedTrack.speakers (the multi-speaker array) is intentionally not
  // carried — the tracks table stores only a singular `speaker`.
  return {
    importFileId,
    trackNumber: parsed.trackNumber,
    title: parsed.title,
    speaker: parsed.speaker,
    languages: parsed.languages,
    originalLanguage: parsed.originalLanguage,
    isTranslation: parsed.isTranslation,
    originalFilename: parsed.originalFilename,
  };
}

const GROUPING_SYSTEM_PROMPT = `You organize Buddhist retreat audio recordings into sessions and clean up each track's title.
A retreat spans one or more days; each day typically has a morning and an afternoon session, sometimes an evening session.
You receive the event code (its leading digits encode the date range, e.g. 20240425_30 means 25-30 April 2024), the list of audio files, and a rule-based first-pass grouping that is often wrong — it frequently dumps every file into a single session.
Return a corrected grouping as a JSON object of exactly this shape:
{"sessions":[{"sessionNumber":1,"titleEn":"...","sessionDate":"YYYY-MM-DD" or null,"timePeriod":"morning"|"afternoon"|"evening" or null,"tracks":[{"importFileId":123,"title":"..."}]}]}
Rules:
- Every audio file id must appear exactly once across all sessions — never drop or duplicate an id.
- Within a session, order the tracks by the leading track number of the filename.
- For each track, provide a cleaned "title": fix obvious typos, capitalisation and spacing in the title carried by the filename. Keep it faithful — do not invent content, do not translate, do not add the speaker or date. If the filename's title is already fine, return it unchanged.
- titleEn (the session title) is a short human label, e.g. "25 April - Morning".
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
  if (!PROPOSABLE_STATUSES.has(job.status)) {
    throw AppError.badRequest(
      `Import job ${importJobId} is in status "${job.status}" and cannot be (re-)proposed`,
      "INVALID_JOB_STATUS",
    );
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

// ---------------------------------------------------------------------------
// confirmStructure — store a human-reviewed session structure
// ---------------------------------------------------------------------------

const CONFIRMABLE_STATUSES = new Set(["proposed", "reviewed"]);

/**
 * Store a human-confirmed session structure on an import job and move it to
 * `reviewed`. The structure shape is validated by `proposedStructureSchema`
 * at the route boundary; this function only enforces the status transition.
 */
export async function confirmStructure(
  importJobId: number,
  structure: ProposedStructure,
) {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId));
  if (!job) {
    throw AppError.notFound(`Import job ${importJobId} not found`);
  }
  if (!CONFIRMABLE_STATUSES.has(job.status)) {
    throw AppError.badRequest(
      `Import job ${importJobId} is in status "${job.status}" and cannot be confirmed`,
      "INVALID_JOB_STATUS",
    );
  }
  const [updated] = await db
    .update(importJobs)
    .set({
      confirmedStructure: structure,
      status: "reviewed",
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId))
    .returning();
  return updated!;
}
