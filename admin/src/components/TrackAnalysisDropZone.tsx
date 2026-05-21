import { useCallback, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import FolderIcon from "@mui/icons-material/FolderOpen";
import CancelIcon from "@mui/icons-material/Cancel";
import { useTranslate } from "react-admin";

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

function formatProgress(
  ev: ProgressEvent,
  t: (key: string) => string,
): string {
  switch (ev.type) {
    case "phase":
      if (ev.phase === "scanning")
        return t("padmakara.import.scanningFolder") || "Scanning folder…";
      if (ev.phase === "deterministic_parse") {
        return (
          t("padmakara.import.parsedSummary") ||
          "Parsed {{files}} files across {{sessions}} sessions"
        )
          .replace("{{files}}", String(ev.totalFiles))
          .replace("{{sessions}}", String(ev.totalSessions));
      }
      if (ev.phase === "ai_analysis") {
        return (
          t("padmakara.import.aiAnalysisStarting") ||
          "Starting AI analysis ({{chunks}} chunks)…"
        )
          .replace("{{chunks}}", String(ev.totalChunks));
      }
      return t("padmakara.import.processing") || "Processing…";
    case "chunk_progress":
      return (
        t("padmakara.import.chunkProgress") ||
        "Analysing… ({{done}}/{{total}} chunks done)"
      )
        .replace("{{done}}", String(ev.done))
        .replace("{{total}}", String(ev.total));
    case "chunk_failed":
      return (
        t("padmakara.import.chunkFailed") ||
        "Chunk {{index}} failed — using fallback"
      ).replace("{{index}}", String(ev.chunkIndex + 1));
    default:
      return t("padmakara.import.working") || "Working…";
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

type DropZonePhase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "analysing"; progressText: string };

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
        progressText:
          t("padmakara.import.startingAnalysis") || "Starting analysis…",
      });

      const onProgress = (ev: ProgressEvent) => {
        setPhase({ kind: "analysing", progressText: formatProgress(ev, t) });
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
    [busy, authToken, apiBase, onAnalyzed, onError],
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
            gap: 1.5,
          }}
        >
          <CircularProgress size={32} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {phase.kind === "scanning"
              ? t("padmakara.import.scanningFiles") || "Scanning audio files…"
              : phase.progressText}
          </Typography>
          {phase.kind === "analysing" && (
            <Button
              size="small"
              color="inherit"
              startIcon={<CancelIcon />}
              onClick={handleCancel}
              sx={{ mt: 0.5 }}
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
