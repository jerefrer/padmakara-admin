import { useCallback, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import FolderIcon from "@mui/icons-material/FolderOpen";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import { useTranslate } from "react-admin";
import {
  type ParsedTrack,
  type FolderMetadata,
  parseTrackFile,
  parseFolderName,
  isMediaFilename,
  isJunkFilename,
  isJunkDirName,
} from "../utils/trackParser";

interface TrackDropZoneProps {
  onFolderDropped: (meta: FolderMetadata, tracks: ParsedTrack[]) => void;
  fileCount: number;
  folderName: string | null;
  /** An "Add audio sessions" link (folder picker) instead of the big box; dropping still works. */
  compact?: boolean;
}

function isMediaFile(file: File): boolean {
  return isMediaFilename(file.name);
}

/** readEntries returns batches — must loop until empty */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else { all.push(...batch); readBatch(); }
      });
    };
    readBatch();
  });
}

function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    if (isJunkFilename(entry.name)) return Promise.resolve([]);
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file((f) => resolve([f]));
    });
  }
  if (entry.isDirectory) {
    if (isJunkDirName(entry.name)) return Promise.resolve([]);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return readAllEntries(reader).then((entries) =>
      Promise.all(entries.map(readEntry)).then((r) => r.flat()),
    );
  }
  return Promise.resolve([]);
}

export const TrackDropZone = ({ onFolderDropped, fileCount, folderName, compact = false }: TrackDropZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const translate = useTranslate();

  const handleFolderFiles = useCallback(
    (folderName: string, files: File[]) => {
      const mediaFiles = files.filter(isMediaFile);
      if (mediaFiles.length === 0) return;
      const parsed = mediaFiles
        .map(parseTrackFile)
        .sort((a, b) => a.trackNumber - b.trackNumber);
      onFolderDropped(parseFolderName(folderName), parsed);
    },
    [onFolderDropped],
  );

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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!e.dataTransfer.items) return;

      const entries = Array.from(e.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean) as FileSystemEntry[];

      // Find the first directory entry
      const dirEntry = entries.find((e) => e.isDirectory);
      if (!dirEntry) return; // Only accept folder drops

      // Read all files from the folder
      readEntry(dirEntry).then((files) => handleFolderFiles(dirEntry.name, files));
    },
    [handleFolderFiles],
  );

  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const handleFolderPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length === 0) return;
      // webkitRelativePath is "Folder/sub/file.mp3"; skip junk folders and files like a drop does.
      const kept = files.filter((f) => {
        const parts = (f.webkitRelativePath || f.name).split("/");
        return !isJunkFilename(f.name) && !parts.slice(0, -1).some(isJunkDirName);
      });
      const folder = (files[0].webkitRelativePath || "").split("/")[0] || files[0].name;
      handleFolderFiles(folder, kept);
    },
    [handleFolderFiles],
  );

  const hasFiles = fileCount > 0;

  return (
    <Box
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        border: "2px dashed",
        borderColor: isDragOver
          ? "primary.main"
          : hasFiles
            ? "success.main"
            : compact
              ? "transparent"
              : "rgba(0,0,0,0.12)",
        borderRadius: 3,
        p: hasFiles ? 2.5 : compact ? 0.5 : 5,
        textAlign: "center",
        cursor: "default",
        transition: "all 0.2s ease",
        backgroundColor: isDragOver
          ? "rgba(155,27,27,0.04)"
          : hasFiles
            ? "rgba(107,175,141,0.04)"
            : "transparent",
      }}
    >
      {hasFiles ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1.5 }}>
          <AudioFileIcon sx={{ color: "success.main", fontSize: 24 }} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            <strong>{translate("padmakara.dropzone.filesFrom", { count: fileCount, folder: folderName })}</strong>
          </Typography>
        </Box>
      ) : compact ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1 }}>
          <input
            ref={(el) => {
              folderInputRef.current = el;
              // Not in React's input typings; lets the picker select a folder.
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFolderPicked}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {translate("padmakara.dropzone.orDrop")}
          </Typography>
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={() => folderInputRef.current?.click()}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.dropzone.addSessions")}
          </Button>
        </Box>
      ) : (
        <>
          <FolderIcon
            sx={{ fontSize: 48, color: isDragOver ? "primary.main" : "rgba(0,0,0,0.15)", mb: 1.5, transition: "color 0.2s" }}
          />
          <Typography variant="body1" sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}>
            {translate("padmakara.dropzone.title")}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {translate("padmakara.dropzone.subtitle")}
          </Typography>
        </>
      )}
    </Box>
  );
};
