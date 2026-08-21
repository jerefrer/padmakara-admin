/**
 * "Add video" modal — the single entry point for attaching a new video to
 * an event. Replaces the old ambient footer (a checkbox describing a video
 * that didn't exist yet, plus separate "Import from URL" / "Add video"
 * buttons) with one gated flow:
 *
 *  1. Title slides (Section 1) — pick exactly one of "define slides now" or
 *     "this file already has slides burnt in". Nothing below is usable
 *     until one is chosen.
 *  2. The file (Section 2) — a drop zone (drag/drop or click-to-browse) OR
 *     a pasted URL. Exactly one source.
 *  3. Upload — hands off to the parent's onUpload/onImportUrl exactly the
 *     way the old gate did (see EventVideosSection.tsx), so the existing
 *     UploadProgress overlay behaviour is unchanged for the file path.
 *
 * See docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md.
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
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import { emptySlideDocument, hasAnySlides, sequenceTotalMs, type SlideDocument } from "@slides/types.ts";
import { SlideEditor, type PendingUploadSlides } from "./SlideEditor";

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

type SlidesMode = "define" | "burnedIn" | null;

export interface AddVideoDialogProps {
  open: boolean;
  onClose: () => void;
  /** Needed for the slide editor's image-line uploads. */
  eventCode?: string;
  /** Needed so "Generate from event data" works before a video row exists —
   *  see the eventId prop on SlideEditor. */
  eventId?: number;
  onUpload: (file: File, pending: PendingUploadSlides) => void;
  onImportUrl: (url: string, title: string | undefined, pending: PendingUploadSlides) => Promise<void>;
}

export const AddVideoDialog = ({ open, onClose, eventCode, eventId, onUpload, onImportUrl }: AddVideoDialogProps) => {
  const translate = useTranslate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [slidesMode, setSlidesMode] = useState<SlidesMode>(null);
  const [draftDoc, setDraftDoc] = useState<SlideDocument>(emptySlideDocument());
  const [slideEditorOpen, setSlideEditorOpen] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState("");
  const [urlTitle, setUrlTitle] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean slate every time the dialog opens — nothing persists
  // across an "Add video" click that was cancelled.
  useEffect(() => {
    if (!open) return;
    setSlidesMode(null);
    setDraftDoc(emptySlideDocument());
    setSlideEditorOpen(false);
    setSelectedFile(null);
    setDragActive(false);
    setUrl("");
    setUrlTitle("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const slidesReady = slidesMode === "burnedIn" || (slidesMode === "define" && hasAnySlides(draftDoc));
  const sectionTwoEnabled = slidesMode !== null;
  const slideCount = draftDoc.intro.length + draftDoc.outro.length;
  const slideSeconds = Math.round((sequenceTotalMs(draftDoc.intro) + sequenceTotalMs(draftDoc.outro)) / 1000);

  const pickFile = (file: File) => {
    if (!looksLikeVideoFile(file)) {
      setError(
        translate("padmakara.videos.addDialog.invalidFileType") ||
          "Choose a video file (MP4, MOV, M4V, MKV, or WEBM)",
      );
      return;
    }
    setError(null);
    setSelectedFile(file);
    setUrl("");
    setUrlTitle("");
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) pickFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (!sectionTwoEnabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) pickFile(file);
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (value) setSelectedFile(null);
  };

  const source: "file" | "url" | null = selectedFile ? "file" : url.trim() ? "url" : null;
  const canSubmit = sectionTwoEnabled && slidesReady && source !== null && !submitting;

  const resetAndClose = () => {
    setSubmitting(false);
    onClose();
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleUpload = async () => {
    if (!canSubmit) return;
    const pending: PendingUploadSlides =
      slidesMode === "burnedIn" ? { slides: null, hasBurnedSlides: true } : { slides: draftDoc, hasBurnedSlides: false };

    if (selectedFile) {
      onUpload(selectedFile, pending);
      resetAndClose();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onImportUrl(url.trim(), urlTitle.trim() || undefined, pending);
      resetAndClose();
    } catch (e: any) {
      setError(e?.message || String(e));
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5, pr: 6 }}>
          <MovieIcon sx={{ color: "primary.main" }} />
          <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.05rem", flex: 1 }}>
            {translate("padmakara.videos.addDialog.title") || "Add video"}
          </Typography>
          <IconButton onClick={handleClose} disabled={submitting} sx={{ position: "absolute", right: 12, top: 12 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ pt: 1 }}>
          <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: "0.05em" }}>
            {translate("padmakara.videos.addDialog.section1Title") || "Title slides"}
          </Typography>
          <Box sx={{ display: "flex", gap: 1.5, mt: 1, mb: 2.5, flexDirection: { xs: "column", sm: "row" } }}>
            <SlidesModeCard
              selected={slidesMode === "define"}
              icon={<SlideshowIcon sx={{ fontSize: 20 }} />}
              title={translate("padmakara.videos.addDialog.cardDefineTitle") || "Add title slides"}
              description={
                translate("padmakara.videos.addDialog.cardDefineDesc") ||
                "Design an intro/outro sequence — it's burned into the video automatically."
              }
              onClick={() => setSlidesMode("define")}
            />
            <SlidesModeCard
              selected={slidesMode === "burnedIn"}
              icon={<MovieIcon sx={{ fontSize: 20 }} />}
              title={translate("padmakara.videos.addDialog.cardBurnedTitle") || "Already has title slides burnt in"}
              description={
                translate("padmakara.videos.addDialog.cardBurnedDesc") ||
                "This file already includes its own intro/outro — no slides needed."
              }
              onClick={() => setSlidesMode("burnedIn")}
            />
          </Box>

          {slidesMode === "define" && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2.5, flexWrap: "wrap" }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<SlideshowIcon sx={{ fontSize: 15 }} />}
                onClick={() => setSlideEditorOpen(true)}
                sx={{ textTransform: "none", fontSize: "0.78rem" }}
              >
                {translate("padmakara.slides.gate.defineButton") || "Define slides"}
              </Button>
              {slideCount > 0 && (
                <Chip
                  label={
                    translate("padmakara.videos.addDialog.slidesSummary", {
                      count: slideCount,
                      seconds: slideSeconds,
                    }) || `${slideCount} slides · ${slideSeconds}s total`
                  }
                  size="small"
                  variant="outlined"
                  sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
                />
              )}
            </Box>
          )}

          <Divider sx={{ mb: 2.5 }} />

          <Typography
            variant="overline"
            color={sectionTwoEnabled ? "text.secondary" : "text.disabled"}
            sx={{ fontWeight: 700, letterSpacing: "0.05em" }}
          >
            {translate("padmakara.videos.addDialog.section2Title") || "The file"}
          </Typography>

          <Box sx={{ opacity: sectionTwoEnabled ? 1 : 0.5, pointerEvents: sectionTwoEnabled ? "auto" : "none", mt: 1 }}>
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
                borderColor: dragActive ? "primary.main" : "rgba(0,0,0,0.15)",
                backgroundColor: dragActive ? "rgba(91,94,166,0.04)" : "transparent",
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
                    sx={{ textTransform: "none", fontSize: "0.72rem", mt: 0.5 }}
                  >
                    {translate("padmakara.videos.addDialog.removeFile") || "Remove"}
                  </Button>
                </>
              ) : (
                <>
                  <CloudUploadIcon sx={{ fontSize: 28, color: "text.secondary" }} />
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {translate("padmakara.videos.addDialog.dropZoneLabel") ||
                      "Drag and drop a video file here, or click to browse"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {translate("padmakara.videos.addDialog.dropZoneHint") || "MP4, MOV, M4V, MKV, or WEBM"}
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
              disabled={!sectionTwoEnabled}
            />

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "center", my: 1.5 }}>
              {translate("padmakara.videos.addDialog.orImportFromUrl") || "or import from a URL"}
            </Typography>

            <TextField
              fullWidth
              size="small"
              label={translate("padmakara.videos.importUrlField") || "Video URL"}
              placeholder="https://drive.google.com/file/d/…"
              helperText={
                translate("padmakara.videos.importUrlHelp") ||
                "Paste a Google Drive share link (the file must be shared as \"Anyone with the link\") or a direct link to a public video file."
              }
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              disabled={!sectionTwoEnabled || !!selectedFile}
              sx={{ mb: 1.5 }}
            />
            <TextField
              fullWidth
              size="small"
              label={translate("padmakara.videos.importTitleField") || "Title (optional)"}
              value={urlTitle}
              onChange={(e) => setUrlTitle(e.target.value)}
              disabled={!sectionTwoEnabled || !!selectedFile || !url.trim()}
            />
          </Box>

          {error && (
            <Typography variant="body2" color="error" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleClose} disabled={submitting} color="inherit" sx={{ textTransform: "none" }}>
            {translate("ra.action.cancel") || "Cancel"}
          </Button>
          <Button
            onClick={() => void handleUpload()}
            disabled={!canSubmit}
            variant="contained"
            disableElevation
            startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : <UploadIcon sx={{ fontSize: 16 }} />}
            sx={{ textTransform: "none" }}
          >
            {translate("padmakara.videos.addDialog.uploadAction") || "Upload"}
          </Button>
        </DialogActions>
      </Dialog>

      <SlideEditor
        open={slideEditorOpen}
        onClose={() => setSlideEditorOpen(false)}
        title={translate("padmakara.slides.gate.draftDialogTitle") || "Slides for the next upload"}
        eventCode={eventCode}
        eventId={eventId}
        initialDocument={draftDoc}
        onSave={(doc) => {
          setDraftDoc(doc);
        }}
      />
    </>
  );
};

/* ───────── One Section-1 selectable card ───────── */

interface SlidesModeCardProps {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

const SlidesModeCard = ({ selected, icon, title, description, onClick }: SlidesModeCardProps) => (
  <Paper
    variant="outlined"
    onClick={onClick}
    sx={{
      flex: 1,
      p: 1.5,
      cursor: "pointer",
      borderWidth: selected ? 2 : 1,
      borderColor: selected ? "primary.main" : "rgba(0,0,0,0.15)",
      backgroundColor: selected ? "rgba(91,94,166,0.04)" : "transparent",
      transition: "border-color 0.15s, background-color 0.15s",
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
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
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
