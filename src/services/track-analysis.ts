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

  const sessions: AnalysisSession[] = inferred.map((s, idx) => ({
    sessionNumber: idx + 1,
    titleEn: s.titleEn,
    titlePt: s.titleEn,
    sessionDate: s.date ?? null,
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
