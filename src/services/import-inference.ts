import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  importJobs,
  importFiles,
  teachers,
  eventTypes,
  retreatGroups,
  places,
  audiences,
} from "../db/schema/index.ts";
import { AppError } from "../lib/errors.ts";
import { config } from "../config.ts";
import {
  parseTrackFilename,
  inferSessions,
  type ParsedTrack,
  type InferredSession,
} from "./track-parser.ts";
import {
  parseEventCode,
  matchEventCodeTokens,
  extractFolderTitle,
  type DateConfidence,
} from "./import-event-matcher.ts";
import { loadInventory, findInventoryEvent } from "./import-inventory.ts";

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

/**
 * Event-level metadata for an import — mirrors the admin event form plus the
 * relation ids. The AI fills the text fields and dates; the deterministic
 * event-code matcher fills the relation ids; the admin reviews everything on
 * the import screen before the event is created.
 */
export interface ProposedEvent {
  titleEn: string;
  titlePt: string;
  mainThemesEn: string;
  mainThemesPt: string;
  sessionThemesEn: string;
  sessionThemesPt: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
  featuredAt: string | null;
  eventTypeId: number | null;
  audienceId: number | null;
  teacherIds: number[];
  placeIds: number[];
  groupIds: number[];
}

/** A transcript PDF to import, with the language the admin assigned it. */
export interface ProposedTranscript {
  importFileId: number;
  language: string;
  originalFilename: string;
}

/**
 * The full proposed (or human-confirmed) structure for an import job.
 * `ignored` holds tracks the human has set aside — they belong to the job's
 * source files but are deliberately excluded from the import (e.g. a duplicate
 * with a Portuguese-named copy of an English recording). They are never
 * written to the real event; they exist so a human can restore them later.
 */
export interface ProposedStructure {
  event: ProposedEvent;
  sessions: ProposedSession[];
  ignored: ProposedTrack[];
  transcripts: ProposedTranscript[];
}

/**
 * Schema for the grouping the AI returns. The AI describes the event itself
 * (text fields + dates), decides which audio files go in which session, and
 * supplies a cleaned title for each track — all other per-track metadata and
 * the event's relation ids are derived deterministically by the caller.
 */
export const aiGroupingSchema = z.object({
  event: z.object({
    titleEn: z.string().min(1),
    titlePt: z.string(),
    mainThemesEn: z.string(),
    mainThemesPt: z.string(),
    sessionThemesEn: z.string(),
    sessionThemesPt: z.string(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  }),
  sessions: z
    .array(
      z.object({
        sessionNumber: z.number().int(),
        titleEn: z.string().min(1),
        sessionDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        timePeriod: z.enum(["morning", "afternoon"]).nullable(),
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

/** Schema for one fully-specified track (carries originalFilename). */
const fullTrackSchema = z.object({
  importFileId: z.number().int(),
  trackNumber: z.number().int(),
  title: z.string(),
  speaker: z.string().nullable(),
  languages: z.array(z.string()),
  originalLanguage: z.string(),
  isTranslation: z.boolean(),
  originalFilename: z.string(),
});

/** Schema for the event-level metadata block of a ProposedStructure. */
const proposedEventSchema = z.object({
  titleEn: z.string(),
  titlePt: z.string(),
  mainThemesEn: z.string(),
  mainThemesPt: z.string(),
  sessionThemesEn: z.string(),
  sessionThemesPt: z.string(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  status: z.string().min(1),
  featuredAt: z.string().nullable(),
  eventTypeId: z.number().int().nullable(),
  audienceId: z.number().int().nullable(),
  teacherIds: z.array(z.number().int()),
  placeIds: z.array(z.number().int()),
  groupIds: z.array(z.number().int()),
});

/** Schema for one transcript PDF in a ProposedStructure. */
const proposedTranscriptSchema = z.object({
  importFileId: z.number().int(),
  language: z.string().min(1),
  originalFilename: z.string(),
});

/**
 * Schema for a full ProposedStructure — used to validate a human-confirmed
 * structure. `event` is required (every proposal builds it). `ignored` and
 * `transcripts` default to `[]` so structures stored before those features
 * existed still parse.
 */
export const proposedStructureSchema = z.object({
  event: proposedEventSchema,
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
        tracks: z.array(fullTrackSchema).min(1),
      }),
    )
    .min(1),
  ignored: z.array(fullTrackSchema).default([]),
  transcripts: z.array(proposedTranscriptSchema).default([]),
});

/**
 * Combine the AI's session grouping (which also carries per-track cleaned
 * titles) with deterministic per-track metadata, the assembled event block,
 * and the transcript list into a full proposed structure.
 * Guarantees referential integrity: throws if the grouping references an
 * unknown file, places a file in more than one session, or omits any file.
 * Sessions are renumbered 1..N in the order the AI returned them; a null
 * session timePeriod defaults to "morning". A fresh proposal never ignores
 * anything — the human curates `ignored` later.
 */
export function assembleProposedStructure(
  grouping: AiGrouping,
  tracksByFileId: Map<number, ProposedTrack>,
  event: ProposedEvent,
  transcripts: ProposedTranscript[],
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

  return { event, sessions, ignored: [], transcripts };
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

const GROUPING_SYSTEM_PROMPT = `You describe a Buddhist retreat event, organize its audio recordings into sessions, and clean up each track's title.
A retreat spans one or more days; each day typically has a morning and an afternoon session.
You receive the event code, hints decoded from it (a source folder title and a date range), the list of audio files, and a rule-based first-pass grouping that is often wrong — it frequently dumps every file into a single session.
Return a JSON object of exactly this shape:
{"event":{"titleEn":"...","titlePt":"...","mainThemesEn":"...","mainThemesPt":"...","sessionThemesEn":"...","sessionThemesPt":"...","startDate":"YYYY-MM-DD" or null,"endDate":"YYYY-MM-DD" or null},"sessions":[{"sessionNumber":1,"titleEn":"...","sessionDate":"YYYY-MM-DD" or null,"timePeriod":"morning"|"afternoon" or null,"tracks":[{"importFileId":123,"title":"..."}]}]}
Rules for "event":
- titleEn: a short, human-readable English title for the retreat — NOT the event code. Infer it from the folder title hint, the teacher, and the track titles.
- titlePt: the European-Portuguese title, or "" if you cannot infer one.
- mainThemesEn / mainThemesPt / sessionThemesEn / sessionThemesPt: short theme summaries when the track titles make the themes clear, otherwise "".
- startDate / endDate: use the decoded date range. If it is only month-precise, keep your best estimate or refine the day from the filenames. If no date is decodable and the filenames carry none, return null.
Rules for "sessions":
- Every audio file id must appear exactly once across all sessions — never drop or duplicate an id.
- Within a session, order the tracks by the leading track number of the filename.
- For each track, provide a cleaned "title": fix obvious typos, capitalisation and spacing in the title carried by the filename. Keep it faithful — do not invent content, do not translate, do not add the speaker or date. If the filename's title is already fine, return it unchanged.
- titleEn (the session title) is a short human label, e.g. "25 April - Morning".
Respond with only the JSON object: no prose, no markdown code fences.`;

interface GroupingHints {
  folderTitle: string | null;
  startDate: string | null;
  endDate: string | null;
  dateConfidence: DateConfidence;
}

function buildGroupingPrompt(
  eventCode: string,
  audioFiles: { id: number; filename: string }[],
  seed: InferredSession[],
  hints: GroupingHints,
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
  const dateLine =
    hints.dateConfidence === "none"
      ? `Date: not decodable from the event code — infer it from the filenames if they carry dates, otherwise return null for startDate/endDate.`
      : `Date decoded from the event code: ${hints.startDate}` +
        (hints.endDate ? ` to ${hints.endDate}` : "") +
        (hints.dateConfidence === "month"
          ? ` (only the month is certain — the day is a guess; refine it from the filenames if you can).`
          : `.`);
  const lines: (string | null)[] = [
    `Event code: ${eventCode}`,
    hints.folderTitle ? `Source folder title hint: "${hints.folderTitle}"` : null,
    dateLine,
    ``,
    `Audio files (id and filename):`,
    fileList,
    ``,
    `Rule-based first-pass grouping (filenames only — map them back to ids):`,
    seedText,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
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
  const transcriptFiles = files.filter(
    (f) => f.extension.toLowerCase() === ".pdf",
  );

  const parsedByFileId = audioFiles.map((f) => ({
    id: f.id,
    parsed: parseTrackFilename(f.filename),
  }));
  const tracksByFileId = new Map<number, ProposedTrack>(
    parsedByFileId.map((p) => [p.id, parsedToProposedTrack(p.parsed, p.id)]),
  );
  const seed = inferSessions(parsedByFileId.map((p) => p.parsed));

  // Hints decoded from the event code + source folder name — fed to the AI
  // (for a good title and dates) and re-used below for entity matching.
  const parsedCode = parseEventCode(job.eventCode);
  let folderTitle: string | null = null;
  try {
    const invEvent = findInventoryEvent(loadInventory(), job.eventCode);
    if (invEvent) folderTitle = extractFolderTitle(invEvent.s3Path);
  } catch {
    // Inventory file unavailable — proceed without a folder-title hint.
  }

  const userPrompt = buildGroupingPrompt(
    job.eventCode,
    audioFiles.map((f) => ({ id: f.id, filename: f.filename })),
    seed,
    {
      folderTitle,
      startDate: parsedCode.startDate,
      endDate: parsedCode.endDate,
      dateConfidence: parsedCode.dateConfidence,
    },
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
    throw AppError.internal("AI grouping did not match the expected shape");
  }

  // Match the event code's abbreviation tokens against the DB lookup tables.
  const [teacherRows, eventTypeRows, groupRows, placeRows, audienceRows] =
    await Promise.all([
      db.select({ id: teachers.id, abbreviation: teachers.abbreviation }).from(teachers),
      db
        .select({ id: eventTypes.id, abbreviation: eventTypes.abbreviation })
        .from(eventTypes),
      db
        .select({ id: retreatGroups.id, abbreviation: retreatGroups.abbreviation })
        .from(retreatGroups),
      db.select({ id: places.id, abbreviation: places.abbreviation }).from(places),
      db.select({ id: audiences.id, nameEn: audiences.nameEn }).from(audiences),
    ]);
  const matched = matchEventCodeTokens(parsedCode.tokens, {
    teachers: teacherRows,
    eventTypes: eventTypeRows,
    groups: groupRows,
    places: placeRows,
    audiences: audienceRows,
  });

  const aiEvent = groupingResult.data.event;
  const proposedEvent: ProposedEvent = {
    titleEn: aiEvent.titleEn,
    titlePt: aiEvent.titlePt,
    mainThemesEn: aiEvent.mainThemesEn,
    mainThemesPt: aiEvent.mainThemesPt,
    sessionThemesEn: aiEvent.sessionThemesEn,
    sessionThemesPt: aiEvent.sessionThemesPt,
    startDate: aiEvent.startDate ?? parsedCode.startDate,
    endDate: aiEvent.endDate ?? parsedCode.endDate,
    status: "draft",
    featuredAt: null,
    eventTypeId: matched.eventTypeId,
    audienceId: matched.audienceId,
    teacherIds: matched.teacherIds,
    placeIds: matched.placeIds,
    groupIds: matched.groupIds,
  };

  // Each cataloged PDF becomes a transcript. Every legacy transcript is
  // English, so there is no per-file language detection.
  const proposedTranscripts: ProposedTranscript[] = transcriptFiles.map((f) => ({
    importFileId: f.id,
    language: "en",
    originalFilename: f.filename,
  }));

  let structure: ProposedStructure;
  try {
    structure = assembleProposedStructure(
      groupingResult.data,
      tracksByFileId,
      proposedEvent,
      proposedTranscripts,
    );
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
// refineStructure — AI conversational adjustment of a proposed structure
// ---------------------------------------------------------------------------

const REFINABLE_STATUSES = new Set(["proposed", "reviewed"]);

/**
 * Schema for the AI's refinement output. Tracks omit `originalFilename` — the
 * backend re-anchors it from import_files (the AI must not touch it). A
 * session may legitimately end up with no tracks (all of them moved away or
 * ignored); the backend drops such sessions. `ignored` carries set-aside
 * tracks and defaults to `[]`.
 */
const refineTrackSchema = z.object({
  importFileId: z.number().int(),
  trackNumber: z.number().int(),
  title: z.string(),
  speaker: z.string().nullable(),
  languages: z.array(z.string()),
  originalLanguage: z.string(),
  isTranslation: z.boolean(),
});

const refineOutputSchema = z.object({
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
        tracks: z.array(refineTrackSchema),
      }),
    )
    .min(1),
  ignored: z.array(refineTrackSchema).default([]),
});

const REFINE_SYSTEM_PROMPT = `You help a human curate the imported session structure for a Buddhist retreat.
You receive the current structure as JSON and a plain-language instruction. Apply the instruction and return the adjusted structure.
The structure has two parts: "sessions" (tracks that will be imported) and "ignored" (tracks the human has deliberately set aside and excluded from the import).
Return a JSON object of exactly this shape:
{"sessions":[{"sessionNumber":1,"titleEn":"...","sessionDate":"YYYY-MM-DD" or null,"timePeriod":"morning"|"afternoon","tracks":[{"importFileId":123,"trackNumber":1,"title":"...","speaker":"..." or null,"languages":["en"],"originalLanguage":"en","isTranslation":false}]}],"ignored":[{"importFileId":124,"trackNumber":1,"title":"...","speaker":null,"languages":["en"],"originalLanguage":"en","isTranslation":false}]}
CRITICAL: keep exactly the same set of importFileId values as the input — every importFileId from the input (whether it was in a session or in "ignored") must appear exactly once in your output, either in a session or in "ignored". Never add, drop, invent, or duplicate a track.
Preserve every track in "ignored" unless the instruction explicitly asks to restore one to a session; likewise only move a track into "ignored" if the instruction asks to ignore or exclude it.
You MAY move tracks between sessions, move tracks to or from "ignored", rename sessions and tracks, change session dates and timePeriods, change track numbers, speakers and languages — whatever the instruction asks for.
Always include the "ignored" key, even if it is an empty array. Do not emit empty sessions — drop any session left with no tracks.
Respond with only the JSON object: no prose, no markdown code fences.`;

/**
 * Adjust an existing proposed structure per a human instruction, via the AI.
 * The input structure comes from the request (it reflects the human's
 * in-progress edits). The AI may reorganise and re-title freely, but the set
 * of importFileIds — across both `sessions` and `ignored` — is verified
 * unchanged, and originalFilename is re-anchored from import_files. The result
 * is stored as the job's proposed_structure.
 */
export async function refineStructure(
  importJobId: number,
  currentStructure: ProposedStructure,
  instruction: string,
) {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, importJobId));
  if (!job) {
    throw AppError.notFound(`Import job ${importJobId} not found`);
  }
  if (!REFINABLE_STATUSES.has(job.status)) {
    throw AppError.badRequest(
      `Import job ${importJobId} is in status "${job.status}" and cannot be refined`,
      "INVALID_JOB_STATUS",
    );
  }

  const files = await db
    .select()
    .from(importFiles)
    .where(eq(importFiles.importJobId, importJobId));
  const fileById = new Map(files.map((f) => [f.id, f]));

  const userPrompt = `Current structure:\n${JSON.stringify(
    currentStructure,
  )}\n\nInstruction:\n${instruction}`;

  const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 16384,
    system: REFINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw AppError.internal("AI returned no text response for the refinement");
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
    throw AppError.internal("AI returned invalid JSON for the refinement");
  }

  const refined = refineOutputSchema.safeParse(parsedJson);
  if (!refined.success) {
    throw AppError.internal("AI refinement did not match the expected shape");
  }

  // The refinement must preserve the exact set of files the human is working
  // with — both the tracks currently in sessions and the ones already set
  // aside in `ignored`. This is the input structure's set, not every
  // import_file: a track stays where the human put it across refinements.
  const expected = new Set<number>();
  for (const session of currentStructure.sessions) {
    for (const track of session.tracks) expected.add(track.importFileId);
  }
  for (const track of currentStructure.ignored) {
    expected.add(track.importFileId);
  }

  const seen = new Set<number>();
  const checkTrack = (importFileId: number) => {
    if (!expected.has(importFileId)) {
      throw AppError.internal(
        `AI refinement introduced unknown import file id ${importFileId}`,
      );
    }
    if (seen.has(importFileId)) {
      throw AppError.internal(
        `AI refinement duplicated import file id ${importFileId}`,
      );
    }
    seen.add(importFileId);
  };
  for (const session of refined.data.sessions) {
    for (const track of session.tracks) checkTrack(track.importFileId);
  }
  for (const track of refined.data.ignored) checkTrack(track.importFileId);
  for (const id of expected) {
    if (!seen.has(id)) {
      throw AppError.internal(`AI refinement dropped import file id ${id}`);
    }
  }

  // Re-anchor originalFilename from import_files (the AI never sees it).
  const reanchor = (
    track: z.infer<typeof refineTrackSchema>,
  ): ProposedTrack => {
    const file = fileById.get(track.importFileId);
    if (!file) {
      throw AppError.internal(
        `import file ${track.importFileId} missing during refinement`,
      );
    }
    return { ...track, originalFilename: file.filename };
  };

  // Renumber sessions 1..N; drop any the AI left empty. The event metadata
  // and the transcript list are not touched by a refinement — the refine AI
  // only reorganises sessions/ignored tracks — so they pass straight through.
  const structure: ProposedStructure = {
    event: currentStructure.event,
    sessions: refined.data.sessions
      .filter((session) => session.tracks.length > 0)
      .map((session, index) => ({
        sessionNumber: index + 1,
        titleEn: session.titleEn,
        sessionDate: session.sessionDate,
        timePeriod: session.timePeriod,
        tracks: session.tracks.map(reanchor),
      })),
    ignored: refined.data.ignored.map(reanchor),
    transcripts: currentStructure.transcripts,
  };

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
