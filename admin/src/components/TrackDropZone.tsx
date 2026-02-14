import { useCallback, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import FolderIcon from "@mui/icons-material/FolderOpen";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import { useTranslate } from "react-admin";
import { type ParsedTrack, type FolderMetadata, parseTrackFile, parseFolderName } from "../utils/trackParser";

interface TrackDropZoneProps {
  onFolderDropped: (meta: FolderMetadata, tracks: ParsedTrack[]) => void;
  fileCount: number;
  folderName: string | null;
}

const ACCEPTED_EXT = /\.(mp3|wav|m4a|flac|ogg)$/i;

function isAudioFile(file: File): boolean {
  return ACCEPTED_EXT.test(file.name);
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
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file((f) => resolve([f]));
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return readAllEntries(reader).then((entries) =>
      Promise.all(entries.map(readEntry)).then((r) => r.flat()),
    );
  }
  return Promise.resolve([]);
}

export const TrackDropZone = ({ onFolderDropped, fileCount, folderName }: TrackDropZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const translate = useTranslate();

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

      const meta = parseFolderName(dirEntry.name);

      // Read all files from the folder
      readEntry(dirEntry).then((files) => {
        const audioFiles = files.filter(isAudioFile);
        if (audioFiles.length === 0) return;

        const parsed = audioFiles
          .map(parseTrackFile)
          .sort((a, b) => a.trackNumber - b.trackNumber);

        onFolderDropped(meta, parsed);
      });
    },
    [onFolderDropped],
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
            : "rgba(0,0,0,0.12)",
        borderRadius: 3,
        p: hasFiles ? 2.5 : 5,
        textAlign: "center",
        cursor: "default",
        transition: "all 0.2s ease",
        backgroundColor: isDragOver
          ? "rgba(91,94,166,0.04)"
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
