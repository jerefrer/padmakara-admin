import Anthropic from "@anthropic-ai/sdk";
import { parseTrackFilename, inferSessions, type ParsedTrack } from "./track-parser.ts";
import type { AnalysisResult, AnalysisSession, AnalysisTrack, AnalysisEvent } from "./track-conventions.ts";
import {
  FOLDER_NAME_CONVENTION,
  FILENAME_CONVENTION,
  WRITING_RULES,
  claudeChunkResponseSchema,
  type ClaudeChunkResponse,
} from "./track-conventions.ts";
import { config } from "../config.ts";

// ─── Input shape (shared with the orchestrator) ──────────────────────

export interface KnownGroup {
  id: string;
  nameEn: string;
  namePt: string;
  slug: string;
  abbreviation: string;
}
export interface KnownTeacher {
  id: string;
  name: string;
  abbreviation: string;
}
export interface KnownPlace {
  id: string;
  name: string;
  abbreviation: string;
}
export interface AnalyzeFolderInput {
  folderName: string;
  files: { relativePath: string; sizeBytes: number }[];
  knownGroups: KnownGroup[];
  knownTeachers: KnownTeacher[];
  knownPlaces: KnownPlace[];
}

// ─── Folder-name regex for the convention check ──────────────────────

const FOLDER_DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})(?:-(\d{2}))?/;

// ─── Deterministic pre-pass ──────────────────────────────────────────

function basenameOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

export function deterministicPrePass(input: AnalyzeFolderInput): AnalysisResult {
  const parsedTracks: ParsedTrack[] = input.files.map((f) =>
    parseTrackFilename(basenameOf(f.relativePath)),
  );
  const inferred = inferSessions(parsedTracks);

  // The deterministic parser is monolingual: `InferredSession` has only
  // `titleEn` and `ParsedTrack` has only `title`. We copy the same string
  // into both EN and PT fallback slots; Claude is responsible for producing
  // proper bilingual values when AI analysis succeeds.
  const sessions: AnalysisSession[] = inferred.map((s, idx) => ({
    sessionNumber: idx + 1,
    titleEn: s.titleEn,
    titlePt: s.titleEn,
    sessionDate: s.date ?? null,
    // Parser types timePeriod as `string | null` but only ever emits
    // "morning" or "afternoon" at runtime (see track-parser.ts).
    timePeriod: (s.timePeriod ?? null) as "morning" | "afternoon" | "evening" | null,
    tracks: s.tracks.map<AnalysisTrack>((t, pos) => ({
      position: pos,
      originalFilename: t.originalFilename,
      correctedFilename: t.originalFilename,
      displayTitleEn: t.title,
      displayTitlePt: t.title,
      corrections: [],
    })),
  }));

  const event = buildDeterministicEvent(input.folderName);
  const totalTracks = input.files.length;

  return {
    aiCoverage: {
      totalTracks,
      tracksAnalyzedByAi: 0,
      tracksFromDeterministicFallback: totalTracks,
      chunks: 0,
      chunksFailed: 0,
    },
    event,
    sessions,
    notes: [],
  };
}

function buildDeterministicEvent(folderName: string): AnalysisEvent {
  const match = folderName.match(FOLDER_DATE_RE);
  const folderConventionOk = match !== null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (match) {
    const [, year, month, startDay, endDay] = match;
    startDate = `${year}-${month}-${startDay}`;
    endDate = endDay ? `${year}-${month}-${endDay}` : startDate;
  }
  return {
    titleEn: folderName.trim() || null,
    titlePt: folderName.trim() || null,
    startDate,
    endDate,
    matchedGroupIds: [],
    matchedTeacherIds: [],
    matchedPlaceIds: [],
    folderConventionOk,
  };
}

// ─── Chunker ──────────────────────────────────────────────────────────

const SINGLE_PASS_THRESHOLD = 80;
const CHUNK_TARGET = 60;
const CHUNK_HARD_MAX = 80;

export interface PartOf {
  partIndex: number;
  partTotal: number;
  sessionRef: number;
}

export interface PlannedSession extends AnalysisSession {
  partOf?: PartOf;
}

export interface Chunk {
  isFirstChunk: boolean;
  sessions: PlannedSession[];
}

export function planChunks(sessions: AnalysisSession[]): Chunk[] {
  const totalTracks = sessions.reduce((n, s) => n + s.tracks.length, 0);
  if (totalTracks <= SINGLE_PASS_THRESHOLD) {
    return [{ isFirstChunk: true, sessions }];
  }

  const chunks: Chunk[] = [];
  let current: PlannedSession[] = [];
  let currentTotal = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push({ isFirstChunk: chunks.length === 0, sessions: current });
      current = [];
      currentTotal = 0;
    }
  };

  for (const session of sessions) {
    if (session.tracks.length > CHUNK_HARD_MAX) {
      flush();
      const partTotal = Math.ceil(session.tracks.length / CHUNK_TARGET);
      const subSize = Math.ceil(session.tracks.length / partTotal);
      for (let i = 0; i < partTotal; i++) {
        const slice = session.tracks.slice(i * subSize, (i + 1) * subSize);
        chunks.push({
          isFirstChunk: chunks.length === 0,
          sessions: [
            {
              ...session,
              tracks: slice,
              partOf: { partIndex: i, partTotal, sessionRef: session.sessionNumber },
            },
          ],
        });
      }
      continue;
    }
    if (currentTotal + session.tracks.length > CHUNK_HARD_MAX) {
      flush();
    }
    current.push(session);
    currentTotal += session.tracks.length;
  }
  flush();
  return chunks;
}

// ─── Claude single-chunk call ──────────────────────────────────────────────

export type ChunkErrorKind =
  | "max_tokens"
  | "invalid_json"
  | "schema_violation"
  | "rate_limit"
  | "network"
  | "timeout";

export interface CallClaudeOptions {
  folderName: string;
  chunk: Chunk;
  knownGroups: KnownGroup[];
  knownTeachers: KnownTeacher[];
  knownPlaces: KnownPlace[];
  signal: AbortSignal;
}

export type ChunkResult =
  | { ok: true; value: ClaudeChunkResponse }
  | { ok: false; error: { kind: ChunkErrorKind; detail?: string } };

const SYSTEM_PROMPT = `
You assist an admin ingesting audio files for a Buddhist retreat centre.
Each event has multiple sessions (one or more per day); each session has
tracks (individual audio files).

${FOLDER_NAME_CONVENTION}

${FILENAME_CONVENTION}

${WRITING_RULES}

Output: a single JSON object matching the schema given in the user
message. No prose, no markdown fences, just JSON.
`.trim();

function buildUserPrompt(opts: CallClaudeOptions): string {
  const partialNotes = opts.chunk.sessions
    .filter((s) => s.partOf)
    .map(
      (s) =>
        `Note: this chunk contains part ${s.partOf!.partIndex + 1} of ${s.partOf!.partTotal} of session ${s.partOf!.sessionRef}. Do not infer session-level fields (titleEn, titlePt, sessionDate, timePeriod) — copy them as given. Correct only the tracks listed.`,
    )
    .join("\n");

  const eventPart = opts.chunk.isFirstChunk
    ? `Folder name received: ${opts.folderName}\n`
    : `(Subsequent chunk — do not return event metadata. Set "event": null.)\n`;

  return [
    eventPart,
    partialNotes && `\n${partialNotes}\n`,
    "Known groups (id, abbreviation, names):",
    JSON.stringify(opts.knownGroups, null, 2),
    "Known teachers (id, abbreviation, name):",
    JSON.stringify(opts.knownTeachers, null, 2),
    "Known places (id, abbreviation, name):",
    JSON.stringify(opts.knownPlaces, null, 2),
    "\nDeterministic pre-pass for the tracks in this chunk:",
    JSON.stringify(opts.chunk.sessions, null, 2),
    "\nReturn JSON of shape:",
    `{
  "event": { titleEn, titlePt, startDate, endDate, matchedGroupIds, matchedTeacherIds, matchedPlaceIds, folderConventionOk } | null,
  "sessions": [{ sessionNumber, titleEn, titlePt, sessionDate, timePeriod, tracks: [{ position, originalFilename, correctedFilename, displayTitleEn, displayTitlePt, corrections: [{ field, before, after, reason }] }] }],
  "notes": [{ severity, message, relatedFilename? }]
}`,
    "\nFor every field you change relative to the deterministic pre-pass, add a corrections entry. For anything suspicious (orphan file, missing track number, deviation from the folder convention, ambiguous date), add a notes entry.",
  ]
    .filter(Boolean)
    .join("\n");
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return cachedClient;
}

export async function callClaudeForChunk(opts: CallClaudeOptions): Promise<ChunkResult> {
  try {
    const message = await getClient().messages.create(
      {
        model: config.anthropic.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(opts) }],
      },
      { signal: opts.signal },
    );

    if (message.stop_reason === "max_tokens") {
      return { ok: false, error: { kind: "max_tokens" } };
    }

    const textBlock = message.content.find((b: { type: string }) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    const text = textBlock?.text ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: { kind: "invalid_json", detail: (e as Error).message } };
    }

    const validated = claudeChunkResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: { kind: "schema_violation", detail: validated.error.message } };
    }
    return { ok: true, value: validated.data };
  } catch (e: unknown) {
    const err = e as { status?: number; name?: string; message?: string };
    if (err.status === 429) return { ok: false, error: { kind: "rate_limit" } };
    if (err.name === "AbortError") return { ok: false, error: { kind: "timeout" } };
    return { ok: false, error: { kind: "network", detail: err.message } };
  }
}
