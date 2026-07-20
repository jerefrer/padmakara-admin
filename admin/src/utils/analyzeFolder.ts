// Mirrors the backend's ProgressEvent and AnalysisResult shapes. Keep in
// sync with src/services/track-analysis.ts and src/services/track-conventions.ts.

export type ProgressEvent =
  | { type: "phase"; phase: "scanning" }
  | { type: "phase"; phase: "deterministic_parse"; totalFiles: number; totalSessions: number }
  | { type: "phase"; phase: "ai_analysis"; totalChunks: number }
  | { type: "chunk_progress"; done: number; total: number }
  | { type: "chunk_failed"; chunkIndex: number; reason: string; willFallback: true };

export interface TrackCorrection {
  field: "title" | "correctedFilename";
  kind: "accents" | "spelling" | "capitalization" | "rename";
  before: string;
  after: string;
}

export interface AnalysisTrack {
  position: number;
  originalFilename: string;
  correctedFilename: string;
  title: string;
  /** Language(s) audible in the file, e.g. ['tib','en'] for a TIB+ENG recording. */
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
  /** Speaker abbreviation from the backend parser, e.g. "KPS". Authoritative. */
  speaker: string | null;
  corrections: TrackCorrection[];
}

export interface AnalysisSession {
  sessionNumber: number;
  titleEn: string;
  titlePt: string;
  sessionDate: string | null;
  timePeriod: "morning" | "afternoon" | "evening" | null;
  tracks: AnalysisTrack[];
}

export interface AnalysisNote {
  severity: "info" | "warning";
  message: string;
  relatedFilename?: string;
}

export interface AnalysisEvent {
  titleEn: string | null;
  titlePt: string | null;
  startDate: string | null;
  endDate: string | null;
  matchedGroupIds: string[];
  matchedTeacherIds: string[];
  matchedPlaceIds: string[];
  /** Event-type id detected from a code in the folder name (e.g. CFR). */
  matchedEventTypeId: string | null;
  folderConventionOk: boolean;
}

export interface AnalysisResult {
  aiCoverage: {
    totalTracks: number;
    tracksAnalyzedByAi: number;
    tracksFromDeterministicFallback: number;
    chunks: number;
    chunksFailed: number;
  };
  event: AnalysisEvent;
  sessions: AnalysisSession[];
  notes: AnalysisNote[];
}

// Shared client-side type for files captured at drop time.
export interface ScannedFile {
  relativePath: string;
  sizeBytes: number;
  file: File;
}

export interface AnalyzeFolderParams {
  folderName: string;
  files: { relativePath: string; sizeBytes: number }[];
  onProgress: (e: ProgressEvent) => void;
  signal: AbortSignal;
  authToken: string;
  apiBase: string;
}

export async function analyzeFolderStream(params: AnalyzeFolderParams): Promise<AnalysisResult> {
  const res = await fetch(`${params.apiBase}/admin/import/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${params.authToken}`,
    },
    body: JSON.stringify({ folderName: params.folderName, files: params.files }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`analyze request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE format: "event: <name>\ndata: <json>\n\n"
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const eventMatch = /event:\s*(\S+)/.exec(raw);
      const dataMatch = /data:\s*(.*)/s.exec(raw);

      if (!eventMatch || !dataMatch) continue;

      const eventName = eventMatch[1];
      const data = JSON.parse(dataMatch[1]);

      if (eventName === "result") {
        result = data as AnalysisResult;
      } else if (eventName === "error") {
        throw new Error(data.message ?? "analyze stream error");
      } else {
        // All other events are progress events
        params.onProgress(data as ProgressEvent);
      }
    }
  }

  if (!result) throw new Error("analyze stream closed without result");
  return result;
}
