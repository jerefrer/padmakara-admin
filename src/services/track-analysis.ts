import Anthropic from "@anthropic-ai/sdk";
import { parseTrackFilename, inferSessions, type ParsedTrack } from "./track-parser.ts";
import type {
  AnalysisResult,
  AnalysisSession,
  AnalysisTrack,
  AnalysisEvent,
  TrackCorrection,
  ClaudeDelta,
  TrackEdit,
} from "./track-conventions.ts";
import {
  FOLDER_NAME_CONVENTION,
  FILENAME_CONVENTION,
  WRITING_RULES,
  claudeDeltaSchema,
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
  // `titleEn` and `ParsedTrack` has only `title`. We seed both session title
  // slots with that value; Claude refines event/session metadata when it runs.
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
      title: t.title,
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
  | "aborted"
  | "insufficient_credit"
  | "auth";

export interface CallClaudeOptions {
  folderName: string;
  chunk: Chunk;
  knownGroups: KnownGroup[];
  knownTeachers: KnownTeacher[];
  knownPlaces: KnownPlace[];
  signal: AbortSignal;
}

export type ChunkResult =
  | { ok: true; value: ClaudeDelta }
  | { ok: false; error: { kind: ChunkErrorKind; detail?: string } };

const SYSTEM_PROMPT = `
You assist an admin ingesting audio files for a Buddhist retreat centre.
Each event has multiple sessions (one or more per day); each session has
tracks (individual audio files).

You are given a deterministic first pass that already grouped the files into
sessions and read each track's title from its filename. That structure is
RELIABLE — do not reproduce it. Your job is only to report what should
CHANGE: genuine title fixes, the event metadata, and any noteworthy issues.

${FOLDER_NAME_CONVENTION}

${FILENAME_CONVENTION}

${WRITING_RULES}

Output: a single JSON object (the delta). No prose, no markdown fences,
just JSON.
`.trim();

function buildUserPrompt(opts: CallClaudeOptions): string {
  const partialNote = opts.chunk.sessions.some((s) => s.partOf)
    ? `\nThis chunk is a partial view of a larger session. Do not infer event metadata from it; just report track edits and notes.\n`
    : "";

  // Flatten the chunk's tracks into a compact list keyed by filename — this is
  // all Claude needs to propose edits.
  const trackLines = opts.chunk.sessions
    .flatMap((s) => s.tracks)
    .map((t) => `  - ${t.originalFilename}  (current title: "${t.title}")`)
    .join("\n");

  const eventPart = opts.chunk.isFirstChunk
    ? `Folder name received: "${opts.folderName}"\nInfer the event metadata (titleEn, titlePt, startDate, endDate, and the matched group/teacher/place ids) from the folder name and the track titles.\n`
    : `(Subsequent chunk — set "event" to null; another chunk handles the event metadata.)\n`;

  return [
    eventPart,
    partialNote,
    "Known groups (id, abbreviation, names):",
    JSON.stringify(opts.knownGroups, null, 2),
    "Known teachers (id, abbreviation, name):",
    JSON.stringify(opts.knownTeachers, null, 2),
    "Known places (id, abbreviation, name):",
    JSON.stringify(opts.knownPlaces, null, 2),
    "\nTracks in this chunk (original filename + current title):",
    trackLines,
    "\nReturn ONLY a delta JSON of this shape:",
    `{
  "event": {
    "titleEn": "short English event title" | null,
    "titlePt": "short Portuguese event title" | null,
    "startDate": "YYYY-MM-DD" | null,
    "endDate": "YYYY-MM-DD" | null,
    "matchedGroupIds": ["<id>"],
    "matchedTeacherIds": ["<id>"],
    "matchedPlaceIds": ["<id>"]
  } | null,
  "trackEdits": [
    {
      "originalFilename": "<exact original filename from the list>",
      "title": "<corrected display title>",            // omit if the title is already fine
      "correctedFilename": "<corrected filename>"      // omit unless a typo in the filename needs fixing
    }
  ],
  "notes": [ { "severity": "info" | "warning", "message": "...", "relatedFilename": "<optional>" } ]
}`,
    "\nOnly include a track in trackEdits if it genuinely needs a change. If a chunk needs no track edits, return an empty trackEdits array. Match each edit to a track by its exact originalFilename.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Strip Markdown code fences (```json ... ``` or ``` ... ```) from Claude's
 * output. Despite the system prompt telling Claude to return raw JSON, it
 * often wraps the answer in a fenced code block. We tolerate that here
 * instead of failing or retrying.
 */
export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  // ```json ... ``` or ``` ... ```
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(trimmed);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  return trimmed;
}

// ─── Anthropic client ─────────────────────────────────────────────────

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return cachedClient;
}

export async function callClaudeForChunk(opts: CallClaudeOptions): Promise<ChunkResult> {
  try {
    // We use `messages.stream()` rather than `messages.create()` because the
    // Anthropic SDK refuses non-streaming calls when `max_tokens` is large
    // enough that the response could plausibly exceed 10 minutes. With
    // max_tokens=32000 this guardrail trips. `.finalMessage()` returns the
    // same Message shape once streaming completes, so the rest of the code
    // below is unchanged.
    const stream = getClient().messages.stream(
      {
        model: config.anthropic.model,
        // Sonnet 4.6 supports up to 64k output tokens. We use 32k as a safety
        // margin — even a 200-track chunk (the practical hard ceiling) outputs
        // well under this. The chunker keeps chunks ≤80 tracks, so truncation
        // should be very rare; if it happens, the max_tokens split-retry path
        // still recovers.
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(opts) }],
      },
      { signal: opts.signal },
    );
    const message = await stream.finalMessage();

    if (message.stop_reason === "max_tokens") {
      return { ok: false, error: { kind: "max_tokens" } };
    }

    const textBlock = message.content.find((b: { type: string }) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    const text = textBlock?.text ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFences(text));
    } catch (e) {
      console.error("[track-analysis] invalid JSON from Claude:", text.slice(0, 500));
      return { ok: false, error: { kind: "invalid_json", detail: (e as Error).message } };
    }

    const validated = claudeDeltaSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[track-analysis] Zod validation failed:", validated.error.message);
      console.error("[track-analysis] payload was:", JSON.stringify(parsed).slice(0, 1000));
      return { ok: false, error: { kind: "schema_violation", detail: validated.error.message } };
    }
    return { ok: true, value: validated.data };
  } catch (e: unknown) {
    const err = e as { status?: number; name?: string; message?: string };
    console.error("[track-analysis] Claude call threw:", {
      name: err.name,
      status: err.status,
      message: err.message,
    });
    if (err.status === 429) return { ok: false, error: { kind: "rate_limit" } };
    if (err.name === "AbortError") return { ok: false, error: { kind: "aborted" } };
    // Specific 400 cases that are not transient — surface them clearly so
    // the admin sees a useful message instead of a generic "AI unavailable".
    const msg = err.message ?? "";
    if (err.status === 400 && /credit balance is too low/i.test(msg)) {
      return { ok: false, error: { kind: "insufficient_credit", detail: msg } };
    }
    if (err.status === 401 || err.status === 403) {
      return { ok: false, error: { kind: "auth", detail: msg } };
    }
    return { ok: false, error: { kind: "network", detail: err.message } };
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────

const PARALLEL_CONCURRENCY = 4;

export type ProgressEvent =
  | { type: "phase"; phase: "scanning" }
  | { type: "phase"; phase: "deterministic_parse"; totalFiles: number; totalSessions: number }
  | { type: "phase"; phase: "ai_analysis"; totalChunks: number }
  | { type: "chunk_progress"; done: number; total: number }
  | { type: "chunk_failed"; chunkIndex: number; reason: ChunkErrorKind; willFallback: true };

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // Process items with limited concurrency using a semaphore-style queue.
  const results: R[] = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  let active = 0;
  let queueIndex = 0;

  await new Promise<void>((resolve, reject) => {
    function runNext() {
      while (active < limit && queueIndex < queue.length) {
        const entry = queue[queueIndex++];
        if (!entry) break;
        active++;
        worker(entry.item, entry.index).then(
          (result) => {
            results[entry.index] = result;
            active--;
            if (queueIndex < queue.length) {
              runNext();
            } else if (active === 0) {
              resolve();
            }
          },
          (err) => reject(err),
        );
      }
      if (queue.length === 0) resolve();
    }
    runNext();
  });

  return results;
}

export async function analyzeFolder(
  input: AnalyzeFolderInput,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  try {
    return await analyzeFolderImpl(input, onProgress, signal);
  } catch (_e) {
    // Should never reach here — all errors are caught at the chunk level.
    // Fallback: return a deterministic-only result.
    const determ = deterministicPrePass(input);
    return determ;
  }
}

async function analyzeFolderImpl(
  input: AnalyzeFolderInput,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  onProgress({ type: "phase", phase: "scanning" });

  const determ = deterministicPrePass(input);
  onProgress({
    type: "phase",
    phase: "deterministic_parse",
    totalFiles: input.files.length,
    totalSessions: determ.sessions.length,
  });

  const chunks = planChunks(determ.sessions);
  onProgress({ type: "phase", phase: "ai_analysis", totalChunks: chunks.length });

  let done = 0;
  const chunkResults = await withConcurrency(chunks, PARALLEL_CONCURRENCY, async (chunk, index) => {
    let result: ChunkResult;
    try {
      result = await runChunkWithRetries(input, chunk, signal);
    } catch (e: unknown) {
      const err = e as { message?: string };
      result = { ok: false, error: { kind: "network", detail: err.message } };
    }
    done++;
    onProgress({ type: "chunk_progress", done, total: chunks.length });
    if (!result.ok) {
      onProgress({
        type: "chunk_failed",
        chunkIndex: index,
        reason: result.error.kind,
        willFallback: true,
      });
    }
    return { chunk, result };
  });

  // Fatal-by-design errors: if every chunk failed for the same blocking
  // reason (no credit, bad API key, etc.), don't silently fall back to the
  // deterministic parser — throw so the admin sees a clear, actionable
  // message instead of "AI unavailable for some tracks".
  const allFailed = chunkResults.every((r) => !r.result.ok);
  if (allFailed) {
    const kinds = new Set(
      chunkResults.map((r) => (r.result.ok ? null : r.result.error.kind)).filter(Boolean),
    );
    if (kinds.size === 1 && kinds.has("insufficient_credit")) {
      throw new Error(
        "Anthropic credit balance is too low. Top up at https://console.anthropic.com/settings/billing and retry.",
      );
    }
    if (kinds.size === 1 && kinds.has("auth")) {
      throw new Error(
        "Anthropic API key is invalid or unauthorized. Check ANTHROPIC_API_KEY in the server env.",
      );
    }
  }

  return mergeChunkResults(determ, chunkResults);
}

async function runChunkWithRetries(
  input: AnalyzeFolderInput,
  chunk: Chunk,
  signal: AbortSignal,
): Promise<ChunkResult> {
  const opts: CallClaudeOptions = {
    folderName: input.folderName,
    chunk,
    knownGroups: input.knownGroups,
    knownTeachers: input.knownTeachers,
    knownPlaces: input.knownPlaces,
    signal,
  };

  let result = await callClaudeForChunk(opts);
  if (result.ok) return result;

  if (result.error.kind === "rate_limit") {
    for (const delay of [2000, 4000, 8000]) {
      try {
        await sleep(delay, signal);
      } catch {
        return result;
      }
      result = await callClaudeForChunk(opts);
      if (result.ok) return result;
      if (result.error.kind !== "rate_limit") break;
    }
    return result;
  }

  if (result.error.kind === "invalid_json" || result.error.kind === "schema_violation") {
    result = await callClaudeForChunk(opts);
    return result;
  }

  if (result.error.kind === "max_tokens") {
    const half = Math.ceil(chunk.sessions.length / 2);
    if (half === 0) return result;
    const a: Chunk = { isFirstChunk: chunk.isFirstChunk, sessions: chunk.sessions.slice(0, half) };
    const b: Chunk = { isFirstChunk: false, sessions: chunk.sessions.slice(half) };
    const [ra, rb] = await Promise.all([
      callClaudeForChunk({ ...opts, chunk: a }),
      callClaudeForChunk({ ...opts, chunk: b }),
    ]);
    if (ra.ok && rb.ok) {
      return {
        ok: true,
        value: {
          event: ra.value.event ?? rb.value.event,
          trackEdits: [...ra.value.trackEdits, ...rb.value.trackEdits],
          notes: [...ra.value.notes, ...rb.value.notes],
        },
      };
    }
    return result;
  }

  if (result.error.kind === "network") {
    result = await callClaudeForChunk(opts);
    return result;
  }

  // timeout and any other kind: bubble up immediately
  return result;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function structuredCloneSession(s: AnalysisSession): AnalysisSession {
  return { ...s, tracks: s.tracks.map((t) => ({ ...t, corrections: [...t.corrections] })) };
}

/**
 * Apply Claude's deltas onto the deterministic result. Tracks are matched by
 * `originalFilename`. For each applied edit we compute the `corrections` array
 * by diffing the deterministic value against the edited value, so "what
 * changed" is derived server-side rather than trusted from the model.
 */
function mergeChunkResults(
  determ: AnalysisResult,
  chunkResults: { chunk: Chunk; result: ChunkResult }[],
): AnalysisResult {
  // Clone the deterministic sessions; index every track by its original
  // filename for O(1) edit application.
  const sessions = determ.sessions.map(structuredCloneSession);
  const trackByFilename = new Map<string, AnalysisTrack>();
  for (const s of sessions) {
    for (const t of s.tracks) trackByFilename.set(t.originalFilename, t);
  }

  const notes: AnalysisResult["notes"] = [];
  let event: AnalysisEvent = determ.event;
  let chunksFailed = 0;
  let aiTracks = 0;

  for (const { chunk, result } of chunkResults) {
    if (!result.ok) {
      chunksFailed++;
      continue;
    }
    // Every track in a successfully-analysed chunk counts as AI-covered,
    // whether or not it ended up being edited.
    aiTracks += chunk.sessions.reduce((n, s) => n + s.tracks.length, 0);

    // Event metadata from the first chunk's delta. Keep the deterministic
    // folderConventionOk (a deterministic fact, not Claude's to decide), and
    // fall back to deterministic values for any null the model returned.
    if (chunk.isFirstChunk && result.value.event) {
      const e = result.value.event;
      event = {
        titleEn: e.titleEn ?? determ.event.titleEn,
        titlePt: e.titlePt ?? determ.event.titlePt,
        startDate: e.startDate ?? determ.event.startDate,
        endDate: e.endDate ?? determ.event.endDate,
        matchedGroupIds: e.matchedGroupIds,
        matchedTeacherIds: e.matchedTeacherIds,
        matchedPlaceIds: e.matchedPlaceIds,
        folderConventionOk: determ.event.folderConventionOk,
      };
    }

    for (const edit of result.value.trackEdits) {
      const track = trackByFilename.get(edit.originalFilename);
      if (!track) continue; // unknown filename — skip silently
      applyTrackEdit(track, edit);
    }

    notes.push(...result.value.notes);
  }

  const totalTracks = determ.aiCoverage.totalTracks;
  // Coverage can't exceed the total even if chunk math overlaps.
  const covered = Math.min(aiTracks, totalTracks);

  return {
    aiCoverage: {
      totalTracks,
      tracksAnalyzedByAi: covered,
      tracksFromDeterministicFallback: totalTracks - covered,
      chunks: chunkResults.length,
      chunksFailed,
    },
    event,
    sessions,
    notes,
  };
}

/** Apply a single track edit in place, recording the diffs as corrections. */
function applyTrackEdit(track: AnalysisTrack, edit: TrackEdit): void {
  const corrections: TrackCorrection[] = [];
  if (edit.title !== undefined && edit.title !== track.title) {
    corrections.push({ field: "title", before: track.title, after: edit.title });
    track.title = edit.title;
  }
  if (
    edit.correctedFilename !== undefined &&
    edit.correctedFilename !== track.correctedFilename
  ) {
    corrections.push({
      field: "correctedFilename",
      before: track.correctedFilename,
      after: edit.correctedFilename,
    });
    track.correctedFilename = edit.correctedFilename;
  }
  track.corrections = corrections;
}
