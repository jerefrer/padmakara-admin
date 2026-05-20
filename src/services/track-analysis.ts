import { parseTrackFilename, inferSessions, type ParsedTrack } from "./track-parser.ts";
import type { AnalysisResult, AnalysisSession, AnalysisTrack, AnalysisEvent } from "./track-conventions.ts";

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
