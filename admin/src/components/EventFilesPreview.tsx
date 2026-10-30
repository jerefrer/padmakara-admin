import { useState } from "react";
import { useDataProvider, useNotify, useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import DescriptionIcon from "@mui/icons-material/Description";
import TranslateIcon from "@mui/icons-material/Translate";
import { type ParsedTrack, formatFileSize, languageLabel } from "../utils/trackParser";
import { authFetch } from "../utils/authFetch";

type FileType = "video" | "transcript" | "audio" | "other";

function getFileType(filename: string | null): FileType {
  if (!filename) return "other";
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  const videoExts = ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv"];
  const transcriptExts = ["pdf", "doc", "docx", "txt"];
  const audioExts = ["mp3", "m4a", "wav", "flac", "ogg", "aac", "wma"];

  if (videoExts.includes(ext)) return "video";
  if (transcriptExts.includes(ext)) return "transcript";
  if (audioExts.includes(ext)) return "audio";
  return "other";
}

function getFileIcon(type: FileType) {
  switch (type) {
    case "video":
      return <VideoFileIcon sx={{ fontSize: 16 }} />;
    case "transcript":
      return <PictureAsPdfIcon sx={{ fontSize: 16 }} />;
    case "audio":
      return <AudioFileIcon sx={{ fontSize: 16 }} />;
    default:
      return <DescriptionIcon sx={{ fontSize: 16 }} />;
  }
}

interface EventFilesPreviewProps {
  transcripts: any[];
  /** Called after a transcript was deleted, so the parent can reload the event. */
  onTranscriptDeleted?: () => void;
}

/**
 * A display row plus the identity needed to fetch the file back out of S3.
 * `transcriptId` is absent for transcripts dropped but not yet saved — those
 * rows render without a download button since there is nothing stored yet.
 */
type FileRowData = ParsedTrack & { transcriptId?: number; hasFile: boolean };

export const EventFilesPreview = ({ transcripts, onTranscriptDeleted }: EventFilesPreviewProps) => {
  if (transcripts.length === 0) return null;

  // Convert transcripts to tracks for display
  const transcriptTracks: FileRowData[] = transcripts.map((t, idx) => ({
    transcriptId: typeof t.id === "number" ? t.id : undefined,
    hasFile: Boolean(t.s3Key),
    trackNumber: 0,
    title: t.originalFilename || `Transcript ${idx + 1}`,
    speaker: null,
    languages: t.languages || [t.language || "unknown"],
    originalLanguage: t.originalLanguage || t.language || "unknown",
    isTranslation: false,
    originalFilename: t.originalFilename || null,
    partNumber: null,
    file: { name: t.originalFilename || "transcript.pdf", size: t.fileSizeBytes || 0 } as File,
    date: null,
    timePeriod: null,
    isPractice: false,
    fileFormat: "pdf",
    mediaType: "audio",
  }));

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, mb: 3 }}>
      {/* Event-level transcripts */}
      {transcriptTracks.length > 0 && (
        <FileSection
          title="Transcripts"
          icon={<PictureAsPdfIcon />}
          tracks={transcriptTracks}
          onDeleted={onTranscriptDeleted}
        />
      )}
    </Box>
  );
};

interface FileSectionProps {
  title: string;
  icon: React.ReactNode;
  tracks: FileRowData[];
  onDeleted?: () => void;
}

const FileSection = ({ title, icon, tracks, onDeleted }: FileSectionProps) => {
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <Box sx={{ color: "primary.main" }}>{icon}</Box>
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.1rem" }}>
          {title}
        </Typography>
        <Chip
          label={`${tracks.length} file${tracks.length !== 1 ? "s" : ""}`}
          size="small"
          variant="outlined"
          sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
        />
      </Box>

      <Paper sx={{ p: 3 }}>
        <Box>
          {tracks.map((track, idx) => (
            <FileRow
              key={idx}
              track={track}
              isLast={idx === tracks.length - 1}
              onDeleted={onDeleted}
            />
          ))}
        </Box>
      </Paper>
    </Box>
  );
};

const FileRow = ({
  track,
  isLast,
  onDeleted,
}: {
  track: FileRowData;
  isLast: boolean;
  onDeleted?: () => void;
}) => {
  const translate = useTranslate();
  const notify = useNotify();
  const dataProvider = useDataProvider();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileType = track.fileFormat ? getFileType(track.originalFilename) : "other";
  const icon = getFileIcon(fileType);

  // Fetches a fresh presigned URL on click rather than holding one in state:
  // the URL is short-lived, and the form can stay open far longer than that.
  const handleDownload = async () => {
    if (!track.transcriptId) return;
    setDownloading(true);
    try {
      const res = await authFetch(`/api/admin/transcripts/${track.transcriptId}/download-url`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { url } = (await res.json()) as { url: string };
      // Same-tab navigation dodges the popup blocker on a user-initiated
      // click; Content-Disposition: attachment keeps the page in place.
      window.location.href = url;
    } catch (err) {
      console.error("Transcript download failed:", err);
      notify(translate("padmakara.transcript.downloadFailed") || "Could not download transcript", {
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    setConfirmOpen(false);
    if (!track.transcriptId) return;
    setDeleting(true);
    try {
      await dataProvider.delete("transcripts", { id: track.transcriptId });
      notify(translate("padmakara.transcript.deleted") || "Transcript removed", { type: "success" });
      onDeleted?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.transcript.deleteFailed") || "Failed to delete transcript"}: ${msg}`, {
        type: "error",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1,
        borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.03)",
        "&:hover": { backgroundColor: "rgba(0,0,0,0.01)" },
      }}
    >
      {/* Icon */}
      <Box sx={{ color: track.isTranslation ? "secondary.main" : "primary.light", flexShrink: 0 }}>{icon}</Box>

      {/* Title */}
      <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }} noWrap>
        {track.title}
      </Typography>

      {/* Translation badge */}
      {track.isTranslation && (
        <Chip
          icon={<TranslateIcon sx={{ fontSize: "12px !important" }} />}
          label="Translation"
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(212,168,83,0.1)",
            color: "secondary.dark",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
          }}
        />
      )}

      {/* File format badge */}
      {track.fileFormat && (
        <Chip
          label={track.fileFormat.toUpperCase()}
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(0,0,0,0.04)",
            color: "text.secondary",
            "& .MuiChip-label": { fontSize: "0.6rem", px: 0.5, fontWeight: 600, fontFamily: "monospace" },
          }}
        />
      )}

      {/* Language badge(s) */}
      {(track.languages && track.languages.length > 1 ? track.languages : [track.originalLanguage || "en"]).map((lang) => (
        <Chip
          key={lang}
          label={languageLabel(lang)}
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(155,27,27,0.06)",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
          }}
        />
      ))}

      {/* File size */}
      <Typography variant="caption" sx={{ color: "text.secondary", fontSize: "0.7rem", minWidth: 50, textAlign: "right" }}>
        {formatFileSize(track.file.size)}
      </Typography>

      {/* Download — only for saved rows that actually have a stored file */}
      {track.transcriptId && track.hasFile && (
        <IconButton
          size="small"
          onClick={handleDownload}
          disabled={downloading}
          sx={{ opacity: 0.5, "&:hover": { opacity: 1, color: "primary.main" } }}
          title={translate("padmakara.transcript.download") || "Download transcript"}
        >
          {downloading ? <CircularProgress size={16} /> : <DownloadIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      )}

      {/* Delete — only for saved rows */}
      {track.transcriptId && (
        <IconButton
          size="small"
          onClick={() => setConfirmOpen(true)}
          disabled={deleting}
          sx={{ opacity: 0.5, "&:hover": { opacity: 1, color: "error.main" } }}
          title={translate("padmakara.transcript.delete") || "Delete transcript"}
        >
          {deleting ? <CircularProgress size={16} /> : <DeleteOutlineIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{translate("padmakara.transcript.deleteTitle") || "Delete transcript"}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontWeight: 600, mb: 1, wordBreak: "break-word" }}>
            {track.title}
          </DialogContentText>
          <DialogContentText>
            {translate("padmakara.transcript.deleteConfirm") || "Delete this transcript? This cannot be undone."}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>
            {translate("padmakara.events.cancel") || "Cancel"}
          </Button>
          <Button color="error" variant="contained" onClick={handleDeleteConfirmed}>
            {translate("padmakara.transcript.deleteAction") || "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
