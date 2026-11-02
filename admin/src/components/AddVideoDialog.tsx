/**
 * "Add video" modal: the single entry point for attaching a new video to an
 * event. Slides come first, the video later, so there are exactly two choices:
 *
 *  - "Prepare slides (upload the video later)": a title and a session. The
 *    parent creates the video row with generated slides and no file, and opens
 *    the slide editor on it. The file is uploaded into that row afterwards
 *    ("Upload video"), which queues the burn with the stored slides.
 *  - "Upload a finished video (no slides)": a file (or a URL) that already
 *    carries its own title slides. It goes straight to Bunny, and slides can't
 *    be added afterwards. The session is pre-selected from a file name that
 *    carries a date and period, e.g. `JKR-Lx-2026-10-10-AM.mp4`.
 */

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CircularProgress from "@mui/material/CircularProgress";
import CloseIcon from "@mui/icons-material/Close";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import MovieIcon from "@mui/icons-material/Movie";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import UploadIcon from "@mui/icons-material/Upload";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import { slideEditorTokens } from "../slideEditorTokens";
import { matchSessionFromFilename, orderedSessions, sessionLabel, type SessionOption } from "../utils/slideSequence";
import type { PendingUploadSlides } from "./SlideEditor";

const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm"];

function looksLikeVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

type Mode = "prepare" | "finished" | null;

export interface PrepareVideoInput {
  title: string;
  sessionId: number | null;
}

export interface AddVideoDialogProps {
  open: boolean;
  onClose: () => void;
  /** The event's sessions, for the session select. */
  sessions?: SessionOption[];
  /** "Prepare slides": create the row with generated slides, then open the editor. */
  onPrepare: (input: PrepareVideoInput) => Promise<void>;
  onUpload: (file: File, pending: PendingUploadSlides) => void;
  onImportUrl: (url: string, title: string | undefined, pending: PendingUploadSlides) => Promise<void>;
}

export const AddVideoDialog = ({ open, onClose, sessions = [], onPrepare, onUpload, onImportUrl }: AddVideoDialogProps) => {
  const translate = useTranslate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<Mode>(null);
  const [title, setTitle] = useState("");
  const [sessionId, setSessionId] = useState<number | "">("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A clean slate every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMode(null);
    setTitle("");
    setSessionId("");
    setSelectedFile(null);
    setDragActive(false);
    setUrl("");
    setUrlTitle("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const pickFile = (file: File) => {
    if (!looksLikeVideoFile(file)) {
      setError(
        translate("padmakara.videos.addDialog.invalidFileType", {
          _: "Choose a video file (MP4, MOV, M4V, MKV, or WEBM)",
        }),
      );
      return;
    }
    setError(null);
    setSelectedFile(file);
    setUrl("");
    setUrlTitle("");
    // Pre-select the session the file name points at, unless one was chosen.
    const match = matchSessionFromFilename(file.name, sessions);
    if (match && sessionId === "") setSessionId(match.id);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) pickFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) pickFile(file);
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (value) setSelectedFile(null);
  };

  const source: "file" | "url" | null = selectedFile ? "file" : url.trim() ? "url" : null;
  const canSubmit =
    !submitting && (mode === "prepare" ? title.trim().length > 0 : mode === "finished" && source !== null);

  const handleClose = () => {
    if (!submitting) onClose();
  };

  const chosenSession: number | null = sessionId === "" ? null : sessionId;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    if (mode === "prepare") {
      setSubmitting(true);
      setError(null);
      try {
        await onPrepare({ title: title.trim(), sessionId: chosenSession });
        onClose();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
      }
      return;
    }

    const pending: PendingUploadSlides = { slides: null, hasBurnedSlides: true, sessionId: chosenSession };
    if (selectedFile) {
      onUpload(selectedFile, pending);
      onClose();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onImportUrl(url.trim(), urlTitle.trim() || undefined, pending);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  const sessionSelect = sessions.length > 0 && (
    <TextField
      select
      fullWidth
      size="small"
      label={translate("padmakara.videos.addDialog.session", { _: "Session" })}
      value={sessionId}
      onChange={(e) => setSessionId(e.target.value === "" ? "" : Number(e.target.value))}
      sx={{ mt: 2 }}
      slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
    >
      <MenuItem value="">{translate("padmakara.videos.addDialog.noSession", { _: "No session" })}</MenuItem>
      {orderedSessions(sessions).map((s) => (
        <MenuItem key={s.id} value={s.id}>
          {sessionLabel(s, sessions)}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5, pr: 6 }}>
        <MovieIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" component="span" sx={{ fontWeight: 600, fontSize: "1.05rem", flex: 1 }}>
          {translate("padmakara.videos.addDialog.title", { _: "Add video" })}
        </Typography>
        <IconButton
          onClick={handleClose}
          disabled={submitting}
          aria-label={translate("padmakara.slides.close", { _: "Close" })}
          sx={{ position: "absolute", right: 12, top: 12 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 1 }}>
        <Box sx={{ display: "flex", gap: 1.5, flexDirection: "column" }}>
          <ModeCard
            selected={mode === "prepare"}
            icon={<SlideshowIcon sx={{ fontSize: 20 }} />}
            title={translate("padmakara.videos.addDialog.cardPrepareTitle", { _: "Prepare slides (upload the video later)" })}
            description={translate("padmakara.videos.addDialog.cardPrepareDesc", {
              _: "Design the intro and outro first. When the video is ready, upload it into this entry and the slides are burned in automatically.",
            })}
            onClick={() => setMode("prepare")}
          />
          <ModeCard
            selected={mode === "finished"}
            icon={<MovieIcon sx={{ fontSize: 20 }} />}
            title={translate("padmakara.videos.addDialog.cardFinishedTitle", { _: "Upload a finished video (no slides)" })}
            description={translate("padmakara.videos.addDialog.cardFinishedDesc", {
              _: "This file already includes its own intro and outro. It goes straight to Bunny, and slides can't be added afterwards.",
            })}
            onClick={() => setMode("finished")}
          />
        </Box>

        {mode === "prepare" && (
          <Box sx={{ mt: 2.5 }}>
            <TextField
              fullWidth
              size="small"
              autoFocus
              label={translate("padmakara.videos.addDialog.videoTitle", { _: "Video title" })}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {sessionSelect}
          </Box>
        )}

        {mode === "finished" && (
          <Box sx={{ mt: 2.5 }}>
            <Divider sx={{ mb: 2 }} />
            <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: "0.05em" }}>
              {translate("padmakara.videos.addDialog.section2Title", { _: "The file" })}
            </Typography>
            <Paper
              variant="outlined"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              sx={{
                mt: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 0.75,
                py: 3,
                px: 2,
                textAlign: "center",
                cursor: "pointer",
                borderStyle: "dashed",
                borderWidth: 2,
                borderColor: dragActive ? "primary.main" : slideEditorTokens.borderStrong,
                backgroundColor: dragActive ? "rgba(155,27,27,0.04)" : "transparent",
                transition: "border-color 0.15s, background-color 0.15s",
              }}
            >
              {selectedFile ? (
                <>
                  <InsertDriveFileIcon sx={{ fontSize: 28, color: "primary.main" }} />
                  <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                    {selectedFile.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatBytes(selectedFile.size)}
                  </Typography>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                    }}
                    sx={{ fontSize: "0.72rem", mt: 0.5 }}
                  >
                    {translate("padmakara.videos.addDialog.removeFile", { _: "Remove" })}
                  </Button>
                </>
              ) : (
                <>
                  <CloudUploadIcon sx={{ fontSize: 28, color: "text.secondary" }} />
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {translate("padmakara.videos.addDialog.dropZoneLabel", {
                      _: "Drag and drop a video file here, or click to browse",
                    })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {translate("padmakara.videos.addDialog.dropZoneHint", { _: "MP4, MOV, M4V, MKV, or WEBM" })}
                  </Typography>
                </>
              )}
            </Paper>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "center", my: 1.5 }}>
              {translate("padmakara.videos.addDialog.orImportFromUrl", { _: "or import from a URL" })}
            </Typography>

            <TextField
              fullWidth
              size="small"
              label={translate("padmakara.videos.importUrlField", { _: "Video URL" })}
              placeholder="https://drive.google.com/file/d/…"
              helperText={translate("padmakara.videos.importUrlHelp", {
                _: 'Paste a Google Drive share link (the file must be shared as "Anyone with the link") or a direct link to a public video file.',
              })}
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              disabled={!!selectedFile}
              sx={{ mb: 1.5 }}
            />
            <TextField
              fullWidth
              size="small"
              label={translate("padmakara.videos.importTitleField", { _: "Title (optional)" })}
              value={urlTitle}
              onChange={(e) => setUrlTitle(e.target.value)}
              disabled={!!selectedFile || !url.trim()}
            />
            {sessionSelect}
          </Box>
        )}

        {error && (
          <Typography variant="body2" color="error" sx={{ mt: 2 }}>
            {error}
          </Typography>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={submitting} color="inherit">
          {translate("ra.action.cancel", { _: "Cancel" })}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          variant="contained"
          disableElevation
          startIcon={
            submitting ? (
              <CircularProgress size={14} color="inherit" />
            ) : mode === "prepare" ? (
              <SlideshowIcon sx={{ fontSize: 16 }} />
            ) : (
              <UploadIcon sx={{ fontSize: 16 }} />
            )
          }
        >
          {mode === "prepare"
            ? translate("padmakara.videos.addDialog.prepareAction", { _: "Prepare slides" })
            : translate("padmakara.videos.addDialog.uploadAction", { _: "Upload" })}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/* ───────── One selectable choice ───────── */

interface ModeCardProps {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

const ModeCard = ({ selected, icon, title, description, onClick }: ModeCardProps) => (
  <Paper
    component="button"
    type="button"
    variant="outlined"
    onClick={onClick}
    aria-pressed={selected}
    sx={{
      all: "unset",
      boxSizing: "border-box",
      p: 1.5,
      cursor: "pointer",
      border: "1px solid",
      borderRadius: 2,
      borderColor: selected ? "primary.main" : slideEditorTokens.borderStrong,
      boxShadow: selected ? "0 0 0 1px #9B1B1B" : "none",
      backgroundColor: selected ? "rgba(155,27,27,0.04)" : "background.paper",
      transition: "border-color 0.15s, background-color 0.15s",
      "&:focus-visible": { outline: "2px solid #9B1B1B", outlineOffset: 2 },
    }}
  >
    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
      {selected ? (
        <CheckCircleIcon sx={{ fontSize: 18, color: "primary.main", mt: "1px", flexShrink: 0 }} />
      ) : (
        <RadioButtonUncheckedIcon sx={{ fontSize: 18, color: "text.disabled", mt: "1px", flexShrink: 0 }} />
      )}
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: selected ? "primary.main" : "text.primary" }}>
          {icon}
          <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
          {description}
        </Typography>
      </Box>
    </Box>
  </Paper>
);
