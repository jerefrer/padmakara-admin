import { useCallback, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/system";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import FolderIcon from "@mui/icons-material/FolderOpen";
import CloseIcon from "@mui/icons-material/Close";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useTranslate } from "react-admin";

const pulse = keyframes`
  0%   { opacity: 0.55; transform: scale(0.92); }
  50%  { opacity: 1;    transform: scale(1.08); }
  100% { opacity: 0.55; transform: scale(0.92); }
`;

import {
  analyzeFolderStream,
  type AnalysisResult,
  type ProgressEvent,
  type ScannedFile,
} from "../utils/analyzeFolder";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);

function isAudioFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// ─── FileSystem walk ─────────────────────────────────────────────────────────

/** readEntries returns batches; loop until empty */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          readBatch();
        }
      });
    };
    readBatch();
  });
}

interface RawFile {
  relativePath: string;
  file: File;
}

function readEntryRecursive(
  entry: FileSystemEntry,
  pathPrefix: string,
): Promise<RawFile[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file((f) => {
        resolve([{ relativePath: pathPrefix + f.name, file: f }]);
      });
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return readAllEntries(reader).then((entries) =>
      Promise.all(
        entries.map((e) => readEntryRecursive(e, `${pathPrefix}${e.name}/`)),
      ).then((r) => r.flat()),
    );
  }
  return Promise.resolve([]);
}

// ─── Progress message formatting ─────────────────────────────────────────────

interface ProgressView {
  label: string;
  /** 0..1 for a determinate bar, or null for an indeterminate one. */
  progress: number | null;
}

/**
 * Map a raw SSE progress event to a human-friendly label + bar value.
 * Deliberately hides implementation details (chunks) from the admin — they
 * only care that titles are being cleaned up and roughly how far along it is.
 * Returns null for events that shouldn't change what's on screen.
 */
function formatProgress(
  ev: ProgressEvent,
  t: (key: string) => string,
): ProgressView | null {
  switch (ev.type) {
    case "phase":
      if (ev.phase === "scanning")
        return { label: t("padmakara.import.scanningFolder") || "Reading your folder…", progress: null };
      if (ev.phase === "deterministic_parse") {
        return {
          label: (
            t("padmakara.import.parsedSummary") ||
            "Found {{files}} tracks in {{sessions}} sessions"
          )
            .replace("{{files}}", String(ev.totalFiles))
            .replace("{{sessions}}", String(ev.totalSessions)),
          progress: 0,
        };
      }
      if (ev.phase === "ai_analysis") {
        return {
          label: t("padmakara.import.aiAnalysing") || "Cleaning up titles and structure…",
          progress: 0,
        };
      }
      return { label: t("padmakara.import.processing") || "Processing…", progress: null };
    case "chunk_progress":
      return {
        label: t("padmakara.import.aiAnalysing") || "Cleaning up titles and structure…",
        progress: ev.total > 0 ? ev.done / ev.total : null,
      };
    case "chunk_failed":
      // Don't surface scary per-chunk failures mid-stream; the final banner
      // covers degradation. Keep whatever is currently on screen.
      return null;
    default:
      return null;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

type DropZonePhase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "analysing"; label: string; progress: number | null };

// ─── Component ────────────────────────────────────────────────────────────────

export interface TrackAnalysisDropZoneProps {
  onAnalyzed: (
    result: AnalysisResult,
    files: ScannedFile[],
    folderName: string,
  ) => void;
  onError?: (err: Error) => void;
  authToken: string;
  apiBase: string;
  /** When set the dropzone shows a compact "files loaded" summary. */
  fileCount?: number;
  folderName?: string | null;
}

export function TrackAnalysisDropZone({
  onAnalyzed,
  onError,
  authToken,
  apiBase,
  fileCount,
  folderName,
}: TrackAnalysisDropZoneProps) {
  const t = useTranslate();
  const [phase, setPhase] = useState<DropZonePhase>({ kind: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase.kind !== "idle";
  const hasFiles = (fileCount ?? 0) > 0;

  // ── Drag handlers ───────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  // ── Cancel ──────────────────────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  // ── Drop ────────────────────────────────────────────────────────────────────

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (busy) return; // ignore double-drops while processing
      if (!e.dataTransfer.items) return;

      const entries = Array.from(e.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean) as FileSystemEntry[];

      const dirEntry = entries.find((en) => en.isDirectory);
      if (!dirEntry) return; // only accept folder drops

      const droppedFolderName = dirEntry.name;

      // ── Phase 1: FS walk ───────────────────────────────────────────────────

      setPhase({ kind: "scanning" });

      let rawFiles: RawFile[];
      try {
        const all = await readEntryRecursive(dirEntry, "");
        rawFiles = all.filter((rf) => isAudioFilename(rf.file.name));
      } catch (err) {
        setPhase({ kind: "idle" });
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (rawFiles.length === 0) {
        setPhase({ kind: "idle" });
        onError?.(new Error(`No audio files found in folder "${droppedFolderName}"`));
        return;
      }

      const scannedFiles: ScannedFile[] = rawFiles.map((rf) => ({
        relativePath: rf.relativePath,
        sizeBytes: rf.file.size,
        file: rf.file,
      }));

      // ── Phase 2: AI analysis via SSE ──────────────────────────────────────

      const ac = new AbortController();
      abortRef.current = ac;
      setPhase({
        kind: "analysing",
        label: t("padmakara.import.startingAnalysis") || "Preparing…",
        progress: null,
      });

      const onProgress = (ev: ProgressEvent) => {
        const view = formatProgress(ev, t);
        if (!view) return; // event that shouldn't change the display
        setPhase({ kind: "analysing", label: view.label, progress: view.progress });
      };

      try {
        const result = await analyzeFolderStream({
          folderName: droppedFolderName,
          files: scannedFiles.map((sf) => ({
            relativePath: sf.relativePath,
            sizeBytes: sf.sizeBytes,
          })),
          onProgress,
          signal: ac.signal,
          authToken,
          apiBase,
        });

        abortRef.current = null;
        setPhase({ kind: "idle" });
        onAnalyzed(result, scannedFiles, droppedFolderName);
      } catch (err) {
        abortRef.current = null;
        setPhase({ kind: "idle" });

        // AbortError means user cancelled — reset silently
        if (err instanceof DOMException && err.name === "AbortError") return;

        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [busy, authToken, apiBase, onAnalyzed, onError, t],
  );

  // ── Border / background colour ──────────────────────────────────────────────

  const borderColor = isDragOver
    ? "primary.main"
    : hasFiles
      ? "success.main"
      : "divider";

  const bgColor = isDragOver
    ? "rgba(91,94,166,0.04)"
    : hasFiles
      ? "rgba(107,175,141,0.04)"
      : "transparent";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Box
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        border: "2px dashed",
        borderColor,
        borderRadius: 3,
        p: hasFiles || busy ? 2.5 : 5,
        textAlign: "center",
        cursor: busy ? "default" : "pointer",
        transition: "all 0.2s ease",
        backgroundColor: bgColor,
      }}
    >
      {/* ── Busy: scanning or analysing ── */}
      {busy && (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            py: 3,
          }}
        >
          {/* Spinning ring with a pulsing AI sparkle in the centre */}
          <Box sx={{ position: "relative", width: 88, height: 88 }}>
            <CircularProgress
              size={88}
              thickness={2.2}
              sx={{ color: "primary.main", position: "absolute", inset: 0 }}
            />
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AutoFixHighIcon
                sx={{
                  fontSize: 38,
                  color: "primary.main",
                  animation: `${pulse} 1.8s ease-in-out infinite`,
                }}
              />
            </Box>
          </Box>

          <Box sx={{ textAlign: "center" }}>
            <Typography variant="h6" sx={{ fontWeight: 700, color: "text.primary" }}>
              {t("padmakara.import.analysingTitle") || "Analyzing your recordings"}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
              {phase.kind === "scanning"
                ? t("padmakara.import.scanningFiles") || "Reading audio files…"
                : phase.label}
            </Typography>
          </Box>

          {/* Progress bar — determinate once chunk progress is known */}
          <Box sx={{ width: "100%", maxWidth: 360 }}>
            <LinearProgress
              variant={
                phase.kind === "analysing" && phase.progress !== null
                  ? "determinate"
                  : "indeterminate"
              }
              value={
                phase.kind === "analysing" && phase.progress !== null
                  ? Math.round(phase.progress * 100)
                  : undefined
              }
              sx={{ height: 8, borderRadius: 4 }}
            />
          </Box>

          {phase.kind === "analysing" && (
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<CloseIcon />}
              onClick={handleCancel}
              sx={{ mt: 0.5, borderRadius: 2, textTransform: "none", px: 2.5 }}
            >
              {t("padmakara.import.cancel") || "Cancel"}
            </Button>
          )}
        </Box>
      )}

      {/* ── Idle + files loaded: compact summary ── */}
      {!busy && hasFiles && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1.5,
          }}
        >
          <AudioFileIcon sx={{ color: "success.main", fontSize: 24 }} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            <strong>
              {(t("padmakara.import.filesLoadedSummary") ||
                "{{count}} files from {{folder}}")
                .replace("{{count}}", String(fileCount))
                .replace("{{folder}}", folderName ?? "folder")}
            </strong>
            {t("padmakara.import.dropToReplace") || " — drop a new folder to replace"}
          </Typography>
        </Box>
      )}

      {/* ── Idle + empty: drop prompt ── */}
      {!busy && !hasFiles && (
        <>
          <FolderIcon
            sx={{
              fontSize: 48,
              color: isDragOver ? "primary.main" : "rgba(0,0,0,0.15)",
              mb: 1.5,
              transition: "color 0.2s",
            }}
          />
          <Typography
            variant="body1"
            sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}
          >
            {t("padmakara.import.dropPrompt") || "Drop a retreat folder here"}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("padmakara.import.dropPromptHint") ||
              "MP3, WAV, M4A, FLAC, OGG — AI will analyse naming and structure"}
          </Typography>
        </>
      )}
    </Box>
  );
}
