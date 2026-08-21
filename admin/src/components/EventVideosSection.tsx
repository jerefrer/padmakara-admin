/**
 * Event-level video list. Videos used to attach to a session; they now
 * belong to the event as a whole, ordered by an event-wide `position`.
 * Rendered on the edit form only (a video needs a real event id to attach
 * to, so the create wizard has nothing to show here until after the event
 * is saved).
 */

import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import MovieIcon from "@mui/icons-material/Movie";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import type { EventVideo } from "../utils/trackParser";
import { AddVideoDialog } from "./AddVideoDialog";
import { MediaPreviewDialog, type MediaSource } from "./MediaPreviewDialog";
import { BurnStatusChip, SlideEditor, type PendingUploadSlides, useVideoSlides } from "./SlideEditor";
import { TranslateDirChip, useFieldTranslate } from "./TranslatableField";
import { LangTag, clickToEditSx, quietInputSx } from "./inlineEditKit";
import { SubtitleChips, SubtitleDetails, useVideoSubtitles } from "./VideoSubtitles";

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
   *  setter so the parent's `videos` state stays in sync. */
  onVideosChange: (updater: (prev: EventVideo[]) => EventVideo[]) => void;
  /** Upload and URL-import still run through the parent — they share the
   *  cross-cutting UploadProgress overlay wired up in EventEdit.
   *
   *  Both also receive the admin's slide declaration from the AddVideoDialog
   *  gate (drafted slides, or the "already has burnt-in slides" flag) —
   *  onImportUrl now carries it too, since a URL import can go through the
   *  burn pipeline exactly like a file upload. */
  onUpload: (file: File, pending: PendingUploadSlides) => void;
  onImportUrl: (url: string, title: string | undefined, pending: PendingUploadSlides) => Promise<void>;
  /** Needed for the slide editor's image-line uploads and its "Generate
   *  from event data" call. Optional so the section still renders before
   *  this prop is threaded through from events.tsx (see integration
   *  report) — the editor degrades gracefully (image upload disabled)
   *  without it. */
  eventCode?: string;
  /** Numeric event id — needed so the draft slide editor's "Generate from
   *  event data" can call the event-scoped defaults route before any video
   *  row exists. */
  eventId?: number;
}

export const EventVideosSection = ({
  videos,
  onVideosChange,
  onUpload,
  onImportUrl,
  eventCode,
  eventId,
}: EventVideosSectionProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [addVideoOpen, setAddVideoOpen] = useState(false);

  const sorted = [...videos].sort((a, b) => a.position - b.position);

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
            eventCode={eventCode}
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
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={() => setAddVideoOpen(true)}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.videos.add") || "Add video"}
          </Button>
        </Box>
      </Paper>

      <MediaPreviewDialog
        open={preview !== null}
        title={preview?.title ?? ""}
        source={preview?.source ?? null}
        onClose={() => setPreview(null)}
      />

      <AddVideoDialog
        open={addVideoOpen}
        onClose={() => setAddVideoOpen(false)}
        eventCode={eventCode}
        eventId={eventId}
        onUpload={onUpload}
        onImportUrl={onImportUrl}
      />
    </Box>
  );
};

/* ───────── One video row: position, click-to-edit titles, date, controls ───────── */

interface VideoRowProps {
  video: EventVideo;
  isFirst: boolean;
  isLast: boolean;
  eventCode?: string;
  onUpdate: (videoId: number, patch: VideoTitlePatch) => Promise<void>;
  onReorder: (videoId: number, direction: -1 | 1) => Promise<void>;
  onDelete: (videoId: number) => Promise<void>;
  onPreview: (state: PreviewState) => void;
}

const VideoRow = ({ video, isFirst, isLast, eventCode, onUpdate, onReorder, onDelete, onPreview }: VideoRowProps) => {
  const translate = useTranslate();
  const [editingTitle, setEditingTitle] = useState(false);
  const [edit, setEdit] = useState({ titleEn: video.titleEn ?? "", titlePt: video.titlePt ?? "" });
  const [deleting, setDeleting] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const subtitles = useVideoSubtitles(video.id);
  const slides = useVideoSlides(video.id);
  // Subtitle generation reads the transcoded audio from Bunny; until the
  // duration is back-filled by the webhook the video is still processing.
  const canGenerateSubtitles = !!video.durationSeconds;
  const ft = useFieldTranslate();
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const slideCount = slides.doc.intro.length + slides.doc.outro.length;

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

  /* The date is edited as a local draft and committed on blur/Enter. Driving
     the input straight off `video.videoDate` made it unusable: an
     <input type="date"> only reports a value once all three segments are
     filled, so the first digit of the year fires a change ("0002-07-24"),
     React restores the input to the still-unchanged prop, and the day/month
     the user had typed are wiped. Committing per keystroke also fired one
     PATCH per year digit, writing 0002/0020/0202 to the server on the way. */
  const [dateDraft, setDateDraft] = useState(video.videoDate ?? "");
  const cancelDateRef = useRef(false);

  useEffect(() => {
    setDateDraft(video.videoDate ?? "");
  }, [video.videoDate]);

  const commitDate = () => {
    if (cancelDateRef.current) {
      cancelDateRef.current = false;
      setDateDraft(video.videoDate ?? "");
      return;
    }
    const next = dateDraft || null;
    if (next === (video.videoDate ?? null)) return;
    void onUpdate(video.id, { videoDate: next });
  };

  const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur(); // blur commits
    } else if (e.key === "Escape") {
      e.preventDefault();
      // blur fires synchronously here, before any state update lands — flag
      // the cancel on a ref so commitDate can see it.
      cancelDateRef.current = true;
      e.currentTarget.blur();
    }
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
    <Box sx={{ borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.04)" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 2,
          py: editingTitle ? 1 : 1.25,
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
          value={dateDraft}
          onChange={(e) => setDateDraft(e.target.value)}
          onBlur={commitDate}
          onKeyDown={handleDateKeyDown}
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

        <SubtitleChips
          state={subtitles}
          canGenerate={canGenerateSubtitles}
          open={subsOpen}
          onToggle={() => setSubsOpen((o) => !o)}
        />

        <BurnStatusChip status={slides.burnStatus} error={slides.burnError} />

        <Tooltip
          title={
            slideCount > 0
              ? translate("padmakara.slides.editButtonCount", { count: slideCount }) || `Slides (${slideCount})`
              : translate("padmakara.slides.editButton") || "Slides"
          }
        >
          <IconButton size="small" onClick={() => setSlidesOpen(true)}>
            <SlideshowIcon sx={{ fontSize: 17, color: slideCount > 0 ? "#b91c1c" : "text.secondary" }} />
          </IconButton>
        </Tooltip>

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

        <Tooltip title={translate("padmakara.videos.delete") || "Delete"}>
          <span>
            <IconButton size="small" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <CircularProgress size={14} />
              ) : (
                <DeleteOutlineIcon sx={{ fontSize: 17, color: "text.secondary" }} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Collapse in={subsOpen} timeout={150} unmountOnExit={false} mountOnEnter>
        <SubtitleDetails
          state={subtitles}
          canGenerate={canGenerateSubtitles}
          bunnyVideoId={video.bunnyVideoId}
        />
      </Collapse>

      <SlideEditor
        open={slidesOpen}
        onClose={() => setSlidesOpen(false)}
        title={
          video.titleEn ||
          video.titlePt ||
          translate("padmakara.slides.dialogTitleFallback") ||
          "Title slides"
        }
        eventCode={eventCode}
        videoId={video.id}
        initialDocument={slides.doc}
        onSave={slides.save}
        saving={slides.saving}
        onGenerateDefaults={slides.generateDefaults}
        generating={slides.generating}
        burnStatus={slides.burnStatus}
        burnError={slides.burnError}
      />
    </Box>
  );
};
