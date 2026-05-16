import { authFetch } from "./authFetch.ts";

// --- Types (mirror the backend ProposedStructure / import_jobs shapes) ---

export interface ProposedTrack {
  importFileId: number;
  trackNumber: number;
  title: string;
  speaker: string | null;
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
}

export interface ProposedSession {
  sessionNumber: number;
  titleEn: string;
  sessionDate: string | null;
  timePeriod: string;
  tracks: ProposedTrack[];
}

export interface ProposedStructure {
  sessions: ProposedSession[];
}

export type ImportStatus =
  | "pending"
  | "cataloged"
  | "proposed"
  | "reviewed"
  | "importing"
  | "completed"
  | "failed";

export interface ImportJob {
  id: number;
  eventCode: string;
  sourceBucket: string;
  status: ImportStatus;
  proposedStructure: ProposedStructure | null;
  confirmedStructure: ProposedStructure | null;
  retreatId: number | null;
  fileCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  catalogedAt: string | null;
  completedAt: string | null;
}

export interface ImportFile {
  id: number;
  importJobId: number;
  sourceS3Key: string;
  zipEntryName: string | null;
  filename: string;
  extension: string;
  sizeBytes: number | null;
  category: string | null;
  language: string | null;
}

export interface AvailableEvent {
  eventCode: string;
  matchStatus: string;
  fileCount: number;
}

// --- Helpers ---

/** Parse a JSON response, throwing the backend's error message on a non-2xx. */
async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<T>;
}

// --- Endpoints ---

export async function listAvailableEvents(): Promise<{
  events: AvailableEvent[];
  total: number;
}> {
  return jsonOrThrow(await authFetch("/api/admin/imports/available"));
}

export async function catalogEvent(eventCode: string): Promise<ImportJob> {
  return jsonOrThrow(
    await authFetch("/api/admin/imports/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventCode }),
    }),
  );
}

export async function getImportJob(
  id: number,
): Promise<ImportJob & { files: ImportFile[] }> {
  return jsonOrThrow(await authFetch(`/api/admin/imports/${id}`));
}

export async function proposeStructure(id: number): Promise<ImportJob> {
  return jsonOrThrow(
    await authFetch(`/api/admin/imports/${id}/propose`, { method: "POST" }),
  );
}

export async function confirmStructure(
  id: number,
  structure: ProposedStructure,
): Promise<ImportJob> {
  return jsonOrThrow(
    await authFetch(`/api/admin/imports/${id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(structure),
    }),
  );
}

export async function executeImport(id: number): Promise<ImportJob> {
  return jsonOrThrow(
    await authFetch(`/api/admin/imports/${id}/execute`, { method: "POST" }),
  );
}
