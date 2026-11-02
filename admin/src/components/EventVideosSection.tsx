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
import UploadIcon from "@mui/icons-material/Upload";
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
import { hasAnySlides } from "@slides/types.ts";
import { authFetch } from "../utils/authFetch";
import { requestDefaultSlides } from "../utils/slideGeneration";
import { isAwaitingFile, type SessionOption } from "../utils/slideSequence";
import type { EventVideo } from "../utils/trackParser";
import { AddVideoDialog, type PrepareVideoInput } from "./AddVideoDialog";
import { MediaPreviewDialog, type MediaSource } from "./MediaPreviewDialog";
import { BurnActionButton, BurnStatusChip, SlideEditor, type PendingUploadSlides, useVideoSlides } from "./SlideEditor";
import { AiReviewChip, TranslateDirChip, useFieldTranslate } from "./TranslatableField";
import { TitlePair } from "./TitlePair";
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

type VideoTitlePatch = Partial<
  Pick<EventVideo, "titleEn" | "titlePt" | "titleEnReviewed" | "titlePtReviewed" | "videoDate" | "sessionId">
>;

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
  /** Uploads a file into a video that has slides and no file yet; queues its burn. */
  onAttachMaster: (videoId: number, file: File) => void;
  /** The event's sessions: the video's session, and the add-video dialog's select. */
  sessions?: SessionOption[];
  /** Numeric event id, needed to prepare slides for a new video. */
  eventId?: number;
}

export const EventVideosSection = ({
  videos,
  onVideosChange,
  onUpload,
  onImportUrl,
  onAttachMaster,
  sessions = [],
  eventId,
}: EventVideosSectionProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [addVideoOpen, setAddVideoOpen] = useState(false);
  // The video whose slide editor should be open (set right after "Prepare slides").
  const [editorVideoId, setEditorVideoId] = useState<number | null>(null);

  const sorted = [...videos].sort((a, b) => a.position - b.position);

  const patchVideo = async (videoId: number, patch: Record<string, unknown>) => {
    const res = await authFetch(`/api/admin/videos/${videoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    try {
      return JSON.parse(await res.text()) as Partial<EventVideo> | null;
    } catch {
      return null; // an empty or non-JSON body: the caller keeps its own patch
    }
  };

  const handleUpdate = async (videoId: number, patch: VideoTitlePatch) => {
    try {
      const updated = await patchVideo(videoId, patch);
      // Choosing a session can also date the video; take the stored date.
      const merged: VideoTitlePatch =
        patch.sessionId != null && updated?.videoDate !== undefined ? { ...patch, videoDate: updated.videoDate } : patch;
      onVideosChange((prev) => prev.map((v) => (v.id === videoId ? { ...v, ...merged } : v)));
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

  // "Prepare slides": generate the default slides for the chosen session, create
  // the row with them and no file, and open the editor on it.
  const handlePrepare = async ({ title, sessionId }: PrepareVideoInput) => {
    if (!eventId) throw new Error("Save the event first");
    const generated = await requestDefaultSlides(`/api/admin/events/${eventId}/slides/defaults`, { sessionId });
    const res = await authFetch(`/api/admin/videos/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        titleEn: title,
        sessionId,
        position: sorted.length,
        slides: generated.slides,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
    }
    const created = (await res.json()) as EventVideo;
    onVideosChange((prev) => [...prev, created]);
    setEditorVideoId(created.id);
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
            sessions={sessions}
            otherVideos={sorted.filter((v) => v.id !== video.id)}
            editorOpen={editorVideoId === video.id}
            onEditorOpenChange={(open) => setEditorVideoId(open ? video.id : null)}
            onAttachMaster={onAttachMaster}
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
        sessions={sessions}
        onPrepare={handlePrepare}
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
  sessions: SessionOption[];
  /** The event's other videos; those with slides can be copied from. */
  otherVideos: EventVideo[];
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  onAttachMaster: (videoId: number, file: File) => void;
  onUpdate: (videoId: number, patch: VideoTitlePatch) => Promise<void>;
  onReorder: (videoId: number, direction: -1 | 1) => Promise<void>;
  onDelete: (videoId: number) => Promise<void>;
  onPreview: (state: PreviewState) => void;
}

const VideoRow = ({
  video,
  isFirst,
  isLast,
  sessions,
  otherVideos,
  editorOpen,
  onEditorOpenChange,
  onAttachMaster,
  onUpdate,
  onReorder,
  onDelete,
  onPreview,
}: VideoRowProps) => {
  const translate = useTranslate();
  const [editingTitle, setEditingTitle] = useState(false);
  const seedEdit = () => ({
    titleEn: video.titleEn ?? "",
    titlePt: video.titlePt ?? "",
    titleEnReviewed: video.titleEnReviewed ?? true,
    titlePtReviewed: video.titlePtReviewed ?? true,
  });
  const [edit, setEdit] = useState(seedEdit);
  const [deleting, setDeleting] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const subtitles = useVideoSubtitles(video.id);
  const slides = useVideoSlides(video.id);
  // Subtitle generation reads the transcoded audio from Bunny; until the
  // duration is back-filled by the webhook the video is still processing.
  const canGenerateSubtitles = !!video.durationSeconds;
  const ft = useFieldTranslate();
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const slideCount = slides.doc.intro.length + slides.doc.outro.length;
  const awaitingFile = isAwaitingFile(video);
  const copySources = otherVideos
    .filter((v) => v.slides && hasAnySlides(v.slides))
    .map((v) => ({
      id: v.id,
      label: v.titleEn || v.titlePt || (translate("padmakara.videos.part", { number: v.position + 1 }) || `Part ${v.position + 1}`),
    }));

  // A file attached, a burn started or finished: the row changed server-side,
  // so re-read what the slides endpoint reports about it (master, burn status).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void slides.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.masterS3Key, video.burnStatus, video.bunnyVideoId]);

  const openEditor = () => {
    setEdit(seedEdit());
    doneRef.current = false;
    setEditingTitle(true);
  };

  const saveTitle = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const seed = seedEdit();
    const dirty =
      edit.titleEn !== seed.titleEn ||
      edit.titlePt !== seed.titlePt ||
      edit.titleEnReviewed !== seed.titleEnReviewed ||
      edit.titlePtReviewed !== seed.titlePtReviewed;
    if (dirty) {
      void onUpdate(video.id, {
        titleEn: edit.titleEn.trim() || null,
        titlePt: edit.titlePt.trim() || null,
        titleEnReviewed: edit.titleEnReviewed,
        titlePtReviewed: edit.titlePtReviewed,
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
          "&:hover": { backgroundColor: editingTitle ? "transparent" : "rgba(155,27,27,0.02)" },
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
                onChange={(e) => setEdit((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
                onKeyDown={handleEditKeyDown}
                sx={quietInputSx}
              />
              {!edit.titleEnReviewed && (
                <AiReviewChip onClick={() => setEdit((p) => ({ ...p, titleEnReviewed: true }))} />
              )}
              <TranslateDirChip
                direction="en-to-pt"
                disabled={!edit.titleEn.trim()}
                pending={ft.translating}
                tooltip={translate("padmakara.events.translateToPt")}
                onClick={async () => {
                  const out = await ft.translate(edit.titleEn, "en-to-pt");
                  if (out != null) setEdit((p) => ({ ...p, titlePt: out, titlePtReviewed: false }));
                }}
              />
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <LangTag code="pt" />
              <InputBase
                fullWidth
                value={edit.titlePt}
                placeholder={translate("padmakara.events.titlePt")}
                onChange={(e) => setEdit((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
                onKeyDown={handleEditKeyDown}
                sx={quietInputSx}
              />
              {!edit.titlePtReviewed && (
                <AiReviewChip onClick={() => setEdit((p) => ({ ...p, titlePtReviewed: true }))} />
              )}
              <TranslateDirChip
                direction="pt-to-en"
                disabled={!edit.titlePt.trim()}
                pending={ft.translating}
                tooltip={translate("padmakara.events.translateToEn")}
                onClick={async () => {
                  const out = await ft.translate(edit.titlePt, "pt-to-en");
                  if (out != null) setEdit((p) => ({ ...p, titleEn: out, titleEnReviewed: false }));
                }}
              />
            </Box>
          </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <TitlePair
              titleEn={video.titleEn}
              titlePt={video.titlePt}
              fallback={displayTitle}
              titleEnReviewed={video.titleEnReviewed ?? true}
              titlePtReviewed={video.titlePtReviewed ?? true}
              onMarkReviewed={(lang) =>
                void onUpdate(
                  video.id,
                  lang === "en" ? { titleEnReviewed: true } : { titlePtReviewed: true },
                )
              }
              primaryProps={{
                title: translate("padmakara.tracks.clickToEdit"),
                onClick: openEditor,
                sx: { fontWeight: 500, ...clickToEditSx },
              }}
            />
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

        {awaitingFile ? (
          <>
            <Chip
              label={translate("padmakara.videos.slidesReadyNoVideo", { _: "Slides ready · video not uploaded" })}
              size="small"
              variant="outlined"
              sx={{ height: 22, flexShrink: 0, "& .MuiChip-label": { fontSize: "0.68rem", px: 0.8 } }}
            />
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadIcon sx={{ fontSize: 15 }} />}
              onClick={() => fileInputRef.current?.click()}
              sx={{ flexShrink: 0, fontSize: "0.72rem", py: 0 }}
            >
              {translate("padmakara.videos.uploadVideo", { _: "Upload video" })}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
              style={{ display: "none" }}
              aria-label={translate("padmakara.videos.uploadVideo", { _: "Upload video" })}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onAttachMaster(video.id, file);
              }}
            />
          </>
        ) : (
          <>
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
          </>
        )}

        <BurnStatusChip status={slides.burnStatus} error={slides.burnError} disk={slides.burnDisk} />
        <BurnActionButton
          hasMaster={slides.hasMaster}
          slideCount={slideCount}
          burnStatus={slides.burnStatus}
          reburning={slides.reburning}
          onReburn={slides.reburn}
        />

        <Tooltip
          title={
            slideCount > 0
              ? translate("padmakara.slides.editButtonCount", { count: slideCount }) || `Slides (${slideCount})`
              : translate("padmakara.slides.editButton") || "Slides"
          }
        >
          <IconButton
            size="small"
            onClick={() => onEditorOpenChange(true)}
            aria-label={translate("padmakara.slides.editButton", { _: "Slides" })}
          >
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
          disabled={awaitingFile}
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
          bunnyVideoId={video.bunnyVideoId ?? ""}
        />
      </Collapse>

      <SlideEditor
        open={editorOpen && !slides.loading}
        onClose={() => onEditorOpenChange(false)}
        title={
          video.titleEn ||
          video.titlePt ||
          translate("padmakara.slides.dialogTitleFallback") ||
          "Title slides"
        }
        videoId={video.id}
        initialDocument={slides.doc}
        onSave={slides.save}
        saving={slides.saving}
        onGenerateDefaults={slides.generateDefaults}
        generating={slides.generating}
        copySources={copySources}
        onCopyFrom={slides.copyFrom}
        copying={slides.copying}
        sessions={sessions}
        sessionId={video.sessionId ?? null}
        onChangeSession={(sessionId) => onUpdate(video.id, { sessionId })}
        videoUploaded={!!video.bunnyVideoId || slides.hasMaster}
        onUploadVideo={awaitingFile ? () => fileInputRef.current?.click() : undefined}
        burnStatus={slides.burnStatus}
        burnError={slides.burnError}
        burnDisk={slides.burnDisk}
        hasMaster={slides.hasMaster}
        reburning={slides.reburning}
        onReburn={slides.reburn}
      />
    </Box>
  );
};
