/**
 * Event-level video list. Videos used to attach to a session; they now
 * belong to the event as a whole, ordered by an event-wide `position`.
 * Rendered on the edit form only (a video needs a real event id to attach
 * to, so the create wizard has nothing to show here until after the event
 * is saved).
 */

import AddIcon from "@mui/icons-material/Add";
import AddLinkIcon from "@mui/icons-material/AddLink";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import MovieIcon from "@mui/icons-material/Movie";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import type { EventVideo } from "../utils/trackParser";
import { MediaPreviewDialog, type MediaSource } from "./MediaPreviewDialog";
import { TranslateDirChip, useFieldTranslate } from "./TranslatableField";
import { LangTag, clickToEditSx, quietInputSx } from "./inlineEditKit";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface PreviewState {
  source: MediaSource;
  title: string;
}

type VideoTitlePatch = Partial<Pick<EventVideo, "titleEn" | "titlePt" | "videoDate">>;

interface EventVideosSectionProps {
  /** Videos for this event — need not be pre-sorted; the section sorts by
   *  position before rendering. */
  videos: EventVideo[];
  /** Functional updater — the section performs its own network calls for
   *  title/date/reorder/delete edits and syncs the result back through this
   *  setter so the parent's `videos` state (also used to render the
   *  SubtitlePanel labels below this section) stays in sync. */
  onVideosChange: (updater: (prev: EventVideo[]) => EventVideo[]) => void;
  /** Upload and URL-import still run through the parent — they share the
   *  cross-cutting UploadProgress overlay wired up in EventEdit. */
  onUpload: (file: File) => void;
  onImportUrl: (url: string, title?: string) => Promise<void>;
}

export const EventVideosSection = ({
  videos,
  onVideosChange,
  onUpload,
  onImportUrl,
}: EventVideosSectionProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sorted = [...videos].sort((a, b) => a.position - b.position);

  const triggerPicker = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again still fires
    if (file) onUpload(file);
  };

  const patchVideo = async (videoId: number, patch: Record<string, unknown>) => {
    const res = await authFetch(`/api/admin/videos/${videoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  };

  const handleUpdate = async (videoId: number, patch: VideoTitlePatch) => {
    try {
      await patchVideo(videoId, patch);
      onVideosChange((prev) => prev.map((v) => (v.id === videoId ? { ...v, ...patch } : v)));
    } catch (err: any) {
      notify(
        translate("padmakara.videos.updateFailed", { message: err?.message || String(err) }),
        { type: "error" },
      );
    }
  };

  const handleReorder = async (videoId: number, direction: -1 | 1) => {
    const idx = sorted.findIndex((v) => v.id === videoId);
    const otherIdx = idx + direction;
    if (idx < 0 || otherIdx < 0 || otherIdx >= sorted.length) return;
    const a = sorted[idx]!;
    const b = sorted[otherIdx]!;
    try {
      await Promise.all([
        patchVideo(a.id, { position: b.position }),
        patchVideo(b.id, { position: a.position }),
      ]);
      onVideosChange((prev) =>
        prev.map((v) => {
          if (v.id === a.id) return { ...v, position: b.position };
          if (v.id === b.id) return { ...v, position: a.position };
          return v;
        }),
      );
    } catch (err: any) {
      notify(
        translate("padmakara.videos.reorderFailed", { message: err?.message || String(err) }),
        { type: "error" },
      );
    }
  };

  const handleDelete = async (videoId: number) => {
    if (
      !window.confirm(
        translate("padmakara.videos.deleteConfirm") ||
          "Delete this video from Bunny? This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      const res = await authFetch(`/api/admin/videos/${videoId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      onVideosChange((prev) => prev.filter((v) => v.id !== videoId));
      notify(translate("padmakara.videos.deleted") || "Video removed", { type: "success" });
    } catch (err: any) {
      notify("padmakara.common.videoRemoveFailed", {
        type: "error",
        messageArgs: { message: err?.message || String(err) },
      });
    }
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <Box sx={{ color: "primary.main" }}>
          <MovieIcon />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.1rem" }}>
          {translate("padmakara.videos.title") || "Videos"}
        </Typography>
        {sorted.length > 0 && (
          <Chip
            label={
              translate("padmakara.videos.count", { count: sorted.length, smart_count: sorted.length }) ||
              `${sorted.length} video${sorted.length !== 1 ? "s" : ""}`
            }
            size="small"
            variant="outlined"
            sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
          />
        )}
      </Box>
      <Paper sx={{ overflow: "hidden" }}>
        {sorted.length === 0 && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
            <Box sx={{ color: "text.disabled", display: "flex" }}>
              <MovieIcon sx={{ fontSize: 18 }} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.85rem", fontStyle: "italic" }}>
              {translate("padmakara.videos.none") || "No videos yet"}
            </Typography>
          </Box>
        )}

        {sorted.map((video, idx) => (
          <VideoRow
            key={video.id}
            video={video}
            isFirst={idx === 0}
            isLast={idx === sorted.length - 1}
            onUpdate={handleUpdate}
            onReorder={handleReorder}
            onDelete={handleDelete}
            onPreview={setPreview}
          />
        ))}

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1.25,
            borderTop: sorted.length > 0 ? "1px dashed rgba(0,0,0,0.06)" : "none",
          }}
        >
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            startIcon={<AddLinkIcon sx={{ fontSize: 16 }} />}
            onClick={() => setImportOpen(true)}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.videos.importUrl") || "Import from URL"}
          </Button>
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={triggerPicker}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.videos.add") || "Add video"}
          </Button>
        </Box>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </Paper>

      <MediaPreviewDialog
        open={preview !== null}
        title={preview?.title ?? ""}
        source={preview?.source ?? null}
        onClose={() => setPreview(null)}
      />

      <ImportVideoUrlDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={onImportUrl}
      />
    </Box>
  );
};

/* ───────── One video row: position, click-to-edit titles, date, controls ───────── */

interface VideoRowProps {
  video: EventVideo;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (videoId: number, patch: VideoTitlePatch) => Promise<void>;
  onReorder: (videoId: number, direction: -1 | 1) => Promise<void>;
  onDelete: (videoId: number) => Promise<void>;
  onPreview: (state: PreviewState) => void;
}

const VideoRow = ({ video, isFirst, isLast, onUpdate, onReorder, onDelete, onPreview }: VideoRowProps) => {
  const translate = useTranslate();
  const [editingTitle, setEditingTitle] = useState(false);
  const [edit, setEdit] = useState({ titleEn: video.titleEn ?? "", titlePt: video.titlePt ?? "" });
  const [deleting, setDeleting] = useState(false);
  const [reordering, setReordering] = useState(false);
  const ft = useFieldTranslate();
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const openEditor = () => {
    setEdit({ titleEn: video.titleEn ?? "", titlePt: video.titlePt ?? "" });
    doneRef.current = false;
    setEditingTitle(true);
  };

  const saveTitle = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const dirty = edit.titleEn !== (video.titleEn ?? "") || edit.titlePt !== (video.titlePt ?? "");
    if (dirty) {
      void onUpdate(video.id, {
        titleEn: edit.titleEn.trim() || null,
        titlePt: edit.titlePt.trim() || null,
      });
    }
    setEditingTitle(false);
  };

  const cancelEdit = () => {
    doneRef.current = true;
    setEditingTitle(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && boxRef.current?.contains(e.relatedTarget as Node)) return;
    saveTitle();
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    void onUpdate(video.id, { videoDate: e.target.value || null });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(video.id);
    } finally {
      setDeleting(false);
    }
  };

  const handleReorderClick = async (direction: -1 | 1) => {
    setReordering(true);
    try {
      await onReorder(video.id, direction);
    } finally {
      setReordering(false);
    }
  };

  const partLabel = translate("padmakara.videos.part", { number: video.position + 1 }) || `Part ${video.position + 1}`;
  const displayTitle = video.titleEn || video.titlePt || translate("padmakara.videos.untitled") || "Untitled video";

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: editingTitle ? 1 : 1.25,
        borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.04)",
        "&:hover": { backgroundColor: editingTitle ? "transparent" : "rgba(91,94,166,0.02)" },
      }}
    >
      <Typography
        variant="caption"
        sx={{
          width: 24,
          textAlign: "right",
          color: "text.secondary",
          fontFamily: "monospace",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {String(video.position + 1).padStart(2, "0")}
      </Typography>

      <Box sx={{ color: "#b91c1c", display: "flex", flexShrink: 0 }}>
        <MovieIcon sx={{ fontSize: 18 }} />
      </Box>

      {editingTitle ? (
        <Box
          ref={boxRef}
          onBlur={handleBlur}
          sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5, py: 0.25, minWidth: 0 }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <LangTag code="en" />
            <InputBase
              autoFocus
              fullWidth
              value={edit.titleEn}
              placeholder={translate("padmakara.events.titleEn")}
              onChange={(e) => setEdit((p) => ({ ...p, titleEn: e.target.value }))}
              onKeyDown={handleEditKeyDown}
              sx={quietInputSx}
            />
            <TranslateDirChip
              direction="en-to-pt"
              disabled={!edit.titleEn.trim()}
              pending={ft.translating}
              tooltip={translate("padmakara.events.translateToPt")}
              onClick={async () => {
                const out = await ft.translate(edit.titleEn, "en-to-pt");
                if (out != null) setEdit((p) => ({ ...p, titlePt: out }));
              }}
            />
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <LangTag code="pt" />
            <InputBase
              fullWidth
              value={edit.titlePt}
              placeholder={translate("padmakara.events.titlePt")}
              onChange={(e) => setEdit((p) => ({ ...p, titlePt: e.target.value }))}
              onKeyDown={handleEditKeyDown}
              sx={quietInputSx}
            />
            <TranslateDirChip
              direction="pt-to-en"
              disabled={!edit.titlePt.trim()}
              pending={ft.translating}
              tooltip={translate("padmakara.events.translateToEn")}
              onClick={async () => {
                const out = await ft.translate(edit.titlePt, "pt-to-en");
                if (out != null) setEdit((p) => ({ ...p, titleEn: out }));
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            noWrap
            title={translate("padmakara.tracks.clickToEdit")}
            onClick={openEditor}
            sx={{
              fontWeight: 500,
              display: "inline-block",
              maxWidth: "100%",
              verticalAlign: "middle",
              ...clickToEditSx,
            }}
          >
            {displayTitle}
          </Typography>
        </Box>
      )}

      <input
        type="date"
        value={video.videoDate ?? ""}
        onChange={handleDateChange}
        style={{
          fontSize: "0.75rem",
          padding: "3px 6px",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 6,
          color: "inherit",
          background: "transparent",
          flexShrink: 0,
        }}
      />

      <Chip
        label={
          video.durationSeconds
            ? formatDuration(video.durationSeconds)
            : translate("padmakara.videos.transcoding") || "Transcoding…"
        }
        size="small"
        variant="outlined"
        sx={{ height: 22, flexShrink: 0, "& .MuiChip-label": { fontSize: "0.68rem", px: 0.8 } }}
      />

      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", flexShrink: 0 }}>
        {video.bunnyVideoId.slice(0, 8)}
      </Typography>

      <IconButton
        size="small"
        onClick={() => handleReorderClick(-1)}
        disabled={isFirst || reordering}
        title={translate("padmakara.videos.moveUp") || "Move up"}
      >
        <ArrowUpwardIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <IconButton
        size="small"
        onClick={() => handleReorderClick(1)}
        disabled={isLast || reordering}
        title={translate("padmakara.videos.moveDown") || "Move down"}
      >
        <ArrowDownwardIcon sx={{ fontSize: 16 }} />
      </IconButton>

      <IconButton
        size="small"
        onClick={() =>
          onPreview({
            source: { kind: "video", videoId: video.id },
            title: video.titleEn || video.titlePt || partLabel,
          })
        }
        sx={{ color: "#b91c1c" }}
        title={translate("padmakara.videos.play") || "Play"}
      >
        <PlayArrowIcon sx={{ fontSize: 20 }} />
      </IconButton>

      <Button
        size="small"
        color="error"
        startIcon={<DeleteOutlineIcon sx={{ fontSize: 14 }} />}
        onClick={handleDelete}
        disabled={deleting}
        sx={{ textTransform: "none", fontSize: "0.75rem" }}
      >
        {deleting
          ? translate("padmakara.videos.deleting") || "Removing…"
          : translate("padmakara.videos.delete") || "Delete"}
      </Button>
    </Box>
  );
};

/* ───────── Import-from-URL dialog ───────── */

interface ImportVideoUrlDialogProps {
  open: boolean;
  onClose: () => void;
  /** Rejects with a user-facing message shown inside the dialog. */
  onImport: (url: string, title?: string) => Promise<void>;
}

const ImportVideoUrlDialog = ({ open, onClose, onImport }: ImportVideoUrlDialogProps) => {
  const translate = useTranslate();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setUrl("");
    setTitle("");
    setError(null);
    onClose();
  };

  const handleImport = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onImport(url.trim(), title.trim() || undefined);
      setUrl("");
      setTitle("");
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 600 }}>
        {translate("padmakara.videos.importUrlTitle") || "Import video from URL"}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {translate("padmakara.videos.importUrlHelp") ||
            "Paste a Google Drive share link or a direct link to a public video file."}
        </Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={translate("padmakara.videos.importUrlField") || "Video URL"}
          placeholder="https://drive.google.com/file/d/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
          sx={{ mb: 2 }}
        />
        <TextField
          fullWidth
          size="small"
          label={translate("padmakara.videos.importTitleField") || "Title (optional)"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
        />
        {error && (
          <Typography variant="body2" color="error" sx={{ mt: 1.5 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={submitting} color="inherit" sx={{ textTransform: "none" }}>
          {translate("ra.action.cancel") || "Cancel"}
        </Button>
        <Button
          onClick={handleImport}
          disabled={submitting || !url.trim()}
          variant="contained"
          startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : <AddLinkIcon sx={{ fontSize: 16 }} />}
          sx={{ textTransform: "none" }}
        >
          {submitting
            ? translate("padmakara.videos.importImporting") || "Importing…"
            : translate("padmakara.videos.importStart") || "Import"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
