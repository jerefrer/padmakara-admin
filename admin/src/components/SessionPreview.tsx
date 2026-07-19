import AddIcon from "@mui/icons-material/Add";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DescriptionIcon from "@mui/icons-material/Description";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import MovieIcon from "@mui/icons-material/Movie";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SelfImprovementIcon from "@mui/icons-material/SelfImprovement";
import TranslateIcon from "@mui/icons-material/Translate";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import {
  type InferredSession,
  type ParsedTrack,
  type SessionVideo,
  formatFileSize,
  languageLabel,
} from "../utils/trackParser";
import type { TrackCorrection } from "../utils/analyzeFolder";
import { MediaPreviewDialog } from "./MediaPreviewDialog";
import { AiReviewChip, TranslateDirChip, useFieldTranslate } from "./TranslatableField";

/** Map keyed by track's originalFilename → list of corrections applied to it. */
export type TrackCorrectionsMap = Map<string, TrackCorrection[]>;

type PreviewSource =
  | { kind: "track"; trackId: number; mediaType: "audio" | "video" }
  | { kind: "session-video"; sessionVideoId: number };

interface PreviewState {
  source: PreviewSource;
  title: string;
}

const LANG_CHIP_COLORS: Record<string, { bg: string; text: string }> = {
  en: { bg: "#eff6ff", text: "#1d4ed8" },
  pt: { bg: "#f0fdf4", text: "#15803d" },
  fr: { bg: "#faf5ff", text: "#7e22ce" },
  tib: { bg: "#fffbeb", text: "#b45309" },
};
const DEFAULT_LANG_CHIP = { bg: "rgba(91,94,166,0.06)", text: "text.primary" };

const LANGUAGE_OPTIONS = ["en", "pt", "fr", "tib"];

/** Small "EN" / "PT" tag that labels a quiet inline input with the same
 *  color vocabulary as the language chips in view mode. */
const LangTag = ({ code }: { code: string }) => {
  const lc = LANG_CHIP_COLORS[code] || DEFAULT_LANG_CHIP;
  return (
    <Box
      sx={{
        height: 20,
        px: 0.9,
        borderRadius: 10,
        backgroundColor: lc.bg,
        color: lc.text,
        fontSize: "0.65rem",
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      {code.toUpperCase()}
    </Box>
  );
};

/** Quiet inline input used by the click-to-edit title editors — sized to sit
 *  in a list row without breaking its rhythm. */
const quietInputSx = {
  flex: 1,
  fontSize: "0.85rem",
  px: 1,
  py: 0.25,
  borderRadius: 1.5,
  backgroundColor: "rgba(91,94,166,0.06)",
  border: "1px solid transparent",
  "&.Mui-focused": {
    backgroundColor: "background.paper",
    borderColor: "primary.main",
    boxShadow: "0 0 0 2px rgba(91,94,166,0.15)",
  },
  "& input": { p: 0 },
} as const;

/** Dashed-underline hover affordance shared by the click-to-edit titles. */
const clickToEditSx = {
  cursor: "text",
  borderBottom: "1px dashed transparent",
  "&:hover": { borderBottomColor: "rgba(91,94,166,0.5)" },
} as const;

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

interface SessionPreviewProps {
  sessions: InferredSession[];
  onSessionTitleChange: (sessionIndex: number, patch: Partial<InferredSession>) => void;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  /** Edit-mode only: deletes the track row + its S3 audio (and read-along
   *  JSON). Confirmation is handled by the row before this fires. */
  onTrackDelete?: (trackId: number) => Promise<void>;
  /** Edit-mode only: triggered when admin picks a new video file for a session. */
  onSessionVideoUpload?: (sessionId: number, file: File) => void;
  /** Edit-mode only: deletes one attached video by its session_videos row id. */
  onSessionVideoDelete?: (sessionVideoId: number) => Promise<void>;
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
  /** When provided, tracks whose originalFilename has an entry will get an
   *  AI-correction badge and an expandable diff panel. Existing callers that
   *  don't pass this prop see NO visual change. */
  trackCorrections?: TrackCorrectionsMap;
}

export const SessionPreview = ({
  sessions,
  onSessionTitleChange,
  onTrackUpdate,
  onTrackDelete,
  onSessionVideoUpload,
  onSessionVideoDelete,
  allTeachers,
  trackCorrections,
}: SessionPreviewProps) => {
  const [preview, setPreview] = useState<PreviewState | null>(null);

  if (sessions.length === 0) return null;

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <Box sx={{ color: "primary.main" }}>
          <AudioFileIcon />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.1rem" }}>
          Sessions
        </Typography>
        <Chip
          label={`${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
          size="small"
          variant="outlined"
          sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
        />
      </Box>
      <Paper sx={{ p: 3 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          {sessions.map((session, idx) => (
            <SessionCard
              key={session.sessionNumber}
              session={session}
              index={idx}
              onTitleChange={(patch) => onSessionTitleChange(idx, patch)}
              onTrackUpdate={onTrackUpdate}
              onTrackDelete={onTrackDelete}
              onSessionVideoUpload={onSessionVideoUpload}
              onSessionVideoDelete={onSessionVideoDelete}
              allTeachers={allTeachers}
              trackCorrections={trackCorrections}
              onPreview={setPreview}
            />
          ))}
        </Box>
      </Paper>
      <MediaPreviewDialog
        open={preview !== null}
        title={preview?.title ?? ""}
        source={preview?.source ?? null}
        onClose={() => setPreview(null)}
      />
    </Box>
  );
};

interface SessionCardProps {
  session: InferredSession;
  index: number;
  onTitleChange: (patch: Partial<InferredSession>) => void;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  onTrackDelete?: (trackId: number) => Promise<void>;
  onSessionVideoUpload?: (sessionId: number, file: File) => void;
  onSessionVideoDelete?: (sessionVideoId: number) => Promise<void>;
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
  trackCorrections?: TrackCorrectionsMap;
  onPreview: (state: PreviewState) => void;
}

const SessionCard = ({
  session,
  index,
  onTitleChange,
  onTrackUpdate,
  onTrackDelete,
  onSessionVideoUpload,
  onSessionVideoDelete,
  allTeachers,
  trackCorrections,
  onPreview,
}: SessionCardProps) => {
  const [expanded, setExpanded] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  // Which track row is currently open in its inline editor. Lives here (not
  // in the row) so ↑/↓ can move the editor from one track to the next.
  const [editingTrack, setEditingTrack] = useState<number | null>(null);
  const translate = useTranslate();
  // Seed from the CURRENT session; re-seeded when the editor opens so an
  // AI-assist apply that changed the session titles underneath us is
  // reflected.
  const seedFromSession = () => ({
    titleEn: session.titleEn,
    titlePt: session.titlePt,
    titleEnReviewed: session.titleEnReviewed,
    titlePtReviewed: session.titlePtReviewed,
  });
  const [edit, setEdit] = useState(seedFromSession);
  const ft = useFieldTranslate();
  const titleDoneRef = useRef(false);
  const titleBoxRef = useRef<HTMLDivElement | null>(null);
  // When the title editor closes on blur, the same click that blurred it may
  // land on the header — swallow that click so it doesn't toggle expansion.
  const titleJustClosedRef = useRef(0);

  // Build date chip label with AM/PM inline
  const dateLabel = (() => {
    if (!session.date) return null;
    const period =
      session.timePeriod === "morning"
        ? " AM"
        : session.timePeriod === "afternoon" || session.timePeriod === "evening"
          ? " PM"
          : "";
    return `${session.date}${period}`;
  })();

  const openTitleEditor = () => {
    setEdit(seedFromSession());
    titleDoneRef.current = false;
    setEditingTitle(true);
  };

  const saveTitle = () => {
    if (titleDoneRef.current) return;
    titleDoneRef.current = true;
    const seed = seedFromSession();
    const dirty =
      edit.titleEn !== seed.titleEn ||
      edit.titlePt !== seed.titlePt ||
      edit.titleEnReviewed !== seed.titleEnReviewed ||
      edit.titlePtReviewed !== seed.titlePtReviewed;
    if (dirty) {
      onTitleChange({
        titleEn: edit.titleEn,
        titlePt: edit.titlePt,
        titleEnReviewed: edit.titleEnReviewed,
        titlePtReviewed: edit.titlePtReviewed,
      });
    }
    titleJustClosedRef.current = Date.now();
    setEditingTitle(false);
  };

  const cancelTitle = () => {
    titleDoneRef.current = true;
    titleJustClosedRef.current = Date.now();
    setEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelTitle();
    }
  };

  const handleTitleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && titleBoxRef.current?.contains(e.relatedTarget as Node)) return;
    saveTitle();
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        borderRadius: 2.5,
        overflow: "hidden",
        border: "1px solid rgba(0,0,0,0.08)",
      }}
    >
      {/* Session header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 2,
          py: 1.5,
          backgroundColor: "rgba(0,0,0,0.015)",
          borderBottom: expanded ? "1px solid rgba(0,0,0,0.06)" : "none",
          cursor: "pointer",
        }}
        onClick={() => {
          if (editingTitle || Date.now() - titleJustClosedRef.current < 250) return;
          setExpanded(!expanded);
        }}
      >
        {/* Session pill */}
        <Box
          sx={{
            height: 28,
            px: 1.5,
            borderRadius: 14,
            backgroundColor: "primary.main",
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.7rem",
            fontWeight: 700,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {translate("padmakara.session.session", {
            number: session.sessionNumber,
          })}
        </Box>

        {editingTitle ? (
          <Box
            ref={titleBoxRef}
            onBlur={handleTitleBlur}
            onClick={(e) => e.stopPropagation()}
            sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5, py: 0.25, cursor: "default" }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <LangTag code="en" />
              <InputBase
                autoFocus
                fullWidth
                value={edit.titleEn}
                placeholder={translate("padmakara.events.titleEn")}
                onChange={(e) => setEdit((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
                onKeyDown={handleTitleKeyDown}
                sx={quietInputSx}
              />
              {!edit.titleEnReviewed && (
                <AiReviewChip onClick={() => setEdit((p) => ({ ...p, titleEnReviewed: true }))} />
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
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <LangTag code="pt" />
              <InputBase
                fullWidth
                value={edit.titlePt}
                placeholder={translate("padmakara.events.titlePt")}
                onChange={(e) => setEdit((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
                onKeyDown={handleTitleKeyDown}
                sx={quietInputSx}
              />
              {!edit.titlePtReviewed && (
                <AiReviewChip onClick={() => setEdit((p) => ({ ...p, titlePtReviewed: true }))} />
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
          </Box>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              title={translate("padmakara.tracks.clickToEdit")}
              onClick={(e) => {
                e.stopPropagation();
                openTitleEditor();
              }}
              sx={{
                fontWeight: 600,
                display: "inline-block",
                maxWidth: "100%",
                verticalAlign: "middle",
                ...clickToEditSx,
              }}
            >
              {session.titleEn}
            </Typography>
          </Box>
        )}

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {/* Video presence badge — shown when this session has at least one
              attached video. Single video: show its duration. Multiple: show
              a count instead of listing every duration inline. */}
          {(session.videos?.length ?? 0) > 0 && (
            <Chip
              icon={<MovieIcon sx={{ fontSize: "12px !important" }} />}
              label={
                session.videos!.length > 1
                  ? translate("padmakara.session.videoCount", { count: session.videos!.length }) ||
                    `${session.videos!.length} videos`
                  : session.videos![0]!.durationSeconds
                    ? formatDuration(session.videos![0]!.durationSeconds!)
                    : translate("padmakara.session.video") || "Video"
              }
              size="small"
              sx={{
                height: 24,
                backgroundColor: "rgba(220, 53, 69, 0.08)",
                color: "#b91c1c",
                "& .MuiChip-label": { fontSize: "0.7rem", px: 0.8, fontWeight: 600 },
                "& .MuiChip-icon": { color: "#b91c1c" },
              }}
            />
          )}

          {/* Date chip with AM/PM inline */}
          {dateLabel && (
            <Chip
              icon={<CalendarTodayIcon sx={{ fontSize: "12px !important" }} />}
              label={dateLabel}
              size="small"
              variant="outlined"
              sx={{
                height: 24,
                "& .MuiChip-label": { fontSize: "0.7rem", px: 0.8 },
              }}
            />
          )}

          <Chip
            label={translate("padmakara.session.tracks", {
              count: session.tracks.length,
            })}
            size="small"
            sx={{
              height: 24,
              backgroundColor: "rgba(91,94,166,0.08)",
              "& .MuiChip-label": {
                fontSize: "0.7rem",
                px: 0.8,
                fontWeight: 600,
              },
            }}
          />

          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ ml: -0.5 }}
          >
            {expanded ? (
              <ExpandLessIcon sx={{ fontSize: 18 }} />
            ) : (
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Box>
      </Box>

      {/* Track list */}
      <Collapse in={expanded}>
        <Box>
          {/* Video section — only meaningful in edit mode where session.id exists. */}
          {session.id && (onSessionVideoUpload || onSessionVideoDelete) && (
            <SessionVideosSection
              sessionId={session.id}
              videos={session.videos ?? []}
              onUpload={onSessionVideoUpload}
              onDelete={onSessionVideoDelete}
              hasFollowingTracks={session.tracks.length > 0}
              sessionTitle={session.titleEn}
              onPreview={onPreview}
            />
          )}
          {session.tracks.map((track, tidx) => (
            <TrackRow
              key={tidx}
              track={track}
              isLast={tidx === session.tracks.length - 1}
              editing={editingTrack === tidx}
              onStartEdit={() => setEditingTrack(tidx)}
              onCloseEdit={() => setEditingTrack((cur) => (cur === tidx ? null : cur))}
              onNavigate={(delta) => {
                const next = tidx + delta;
                setEditingTrack(next >= 0 && next < session.tracks.length ? next : null);
              }}
              onTrackUpdate={onTrackUpdate}
              onTrackDelete={onTrackDelete}
              allTeachers={allTeachers}
              corrections={trackCorrections?.get(track.originalFilename ?? "")}
              onPreview={onPreview}
            />
          ))}
        </Box>
      </Collapse>
    </Paper>
  );
};

/* ───────── Session-level video row (edit mode only) ───────── */

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface SessionVideosSectionProps {
  sessionId: number;
  /** Videos for this session, ordered by position (backend already orders
   *  these — no client re-sort needed). */
  videos: SessionVideo[];
  onUpload?: (sessionId: number, file: File) => void;
  onDelete?: (sessionVideoId: number) => Promise<void>;
  hasFollowingTracks: boolean;
  sessionTitle: string;
  onPreview: (state: PreviewState) => void;
}

/**
 * Renders one row per video attached to a session (a session may have
 * several now), plus an "Add video" affordance below the list. Replaces the
 * old single-video row — there is no per-video "Replace" action; to swap a
 * video an admin deletes it and adds a new one.
 */
const SessionVideosSection = ({
  sessionId,
  videos,
  onUpload,
  onDelete,
  hasFollowingTracks,
  sessionTitle,
  onPreview,
}: SessionVideosSectionProps) => {
  const translate = useTranslate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const triggerPicker = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again still fires
    if (file && onUpload) onUpload(sessionId, file);
  };

  return (
    <Box
      sx={{
        borderBottom: hasFollowingTracks ? "1px dashed rgba(0,0,0,0.06)" : "none",
        "& > *:not(:last-child)": {
          borderBottom: "1px dashed rgba(0,0,0,0.06)",
        },
      }}
    >
      {videos.map((video) => (
        <SessionVideoRow
          key={video.id}
          video={video}
          sessionTitle={sessionTitle}
          showPartLabel={videos.length > 1}
          onDelete={onDelete}
          onPreview={onPreview}
        />
      ))}

      {/* Empty state / add-video row */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1.25,
        }}
      >
        {videos.length === 0 && (
          <>
            <Box sx={{ color: "text.disabled", display: "flex" }}>
              <VideoFileIcon sx={{ fontSize: 18 }} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.85rem", fontStyle: "italic" }}>
              {translate("padmakara.session.videoNone") || "No video recording"}
            </Typography>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        {onUpload && (
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={triggerPicker}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.session.videoAdd") || "Add video"}
          </Button>
        )}
      </Box>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </Box>
  );
};

interface SessionVideoRowProps {
  video: SessionVideo;
  sessionTitle: string;
  /** True when the session has 2+ videos — shows a "Part N" label so rows
   *  are distinguishable. */
  showPartLabel: boolean;
  onDelete?: (sessionVideoId: number) => Promise<void>;
  onPreview: (state: PreviewState) => void;
}

const SessionVideoRow = ({
  video,
  sessionTitle,
  showPartLabel,
  onDelete,
  onPreview,
}: SessionVideoRowProps) => {
  const translate = useTranslate();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm(translate("padmakara.session.videoDeleteConfirm") || "Detach this video and delete it from Bunny? This cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      await onDelete(video.id);
    } finally {
      setDeleting(false);
    }
  };

  const partLabel = `${translate("padmakara.session.part") || "Part"} ${video.position + 1}`;
  const previewTitle = video.title ?? (showPartLabel ? `${sessionTitle} — ${partLabel}` : sessionTitle);

  // Common row styling — matches TrackRow's visual weight without copying its
  // semantics. Sits inside the Collapse, above the track list.
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        py: 1.25,
        backgroundColor: "rgba(220, 53, 69, 0.025)",
      }}
    >
      <Box sx={{ color: "#b91c1c", display: "flex" }}>
        <MovieIcon sx={{ fontSize: 18 }} />
      </Box>

      <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.85rem" }}>
        {video.title ?? (showPartLabel ? partLabel : translate("padmakara.session.videoAttached") || "Video recording attached")}
      </Typography>
      <Chip
        label={video.durationSeconds ? formatDuration(video.durationSeconds) : translate("padmakara.session.videoTranscoding") || "Transcoding…"}
        size="small"
        variant="outlined"
        sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.68rem", px: 0.8 } }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ ml: 1, fontFamily: "monospace" }}>
        {video.bunnyVideoId.slice(0, 8)}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <IconButton
        size="small"
        onClick={() =>
          onPreview({
            source: { kind: "session-video", sessionVideoId: video.id },
            title: previewTitle,
          })
        }
        sx={{ color: "#b91c1c" }}
        title={translate("padmakara.session.videoPlay") || "Play"}
      >
        <PlayArrowIcon sx={{ fontSize: 20 }} />
      </IconButton>
      {onDelete && (
        <Button
          size="small"
          color="error"
          startIcon={<DeleteOutlineIcon sx={{ fontSize: 14 }} />}
          onClick={handleDelete}
          disabled={deleting}
          sx={{ textTransform: "none", fontSize: "0.75rem" }}
        >
          {deleting
            ? translate("padmakara.session.videoDeleting") || "Removing…"
            : translate("padmakara.session.videoDelete") || "Delete"}
        </Button>
      )}
    </Box>
  );
};

/** Strip any remaining "SPEAKER - " prefix from title for display */
function cleanTitle(track: ParsedTrack): string {
  let t = track.title;
  if (track.speaker) {
    t = t
      .replace(new RegExp(`^${track.speaker}\\s*-\\s+`, "i"), "")
      .replace(new RegExp(`^${track.speaker}\\s*-\\s*`, "i"), "")
      .replace(new RegExp(`^${track.speaker}[\\s_]+`, "i"), "");
  }
  // Fallback: strip any leading 2-5 letter abbreviation + " - " pattern
  t = t.replace(/^[A-Z]{2,5}\s*-\s+/i, "");
  // Also strip any TRAD prefix that might remain
  t = t.replace(/^TRAD\s*-\s+/i, "").replace(/^TRAD[\s_]+/i, "");
  return t || track.title;
}

const TrackRow = ({
  track,
  isLast,
  editing,
  onStartEdit,
  onCloseEdit,
  onNavigate,
  onTrackUpdate,
  onTrackDelete,
  allTeachers = [],
  corrections,
  onPreview,
}: {
  track: ParsedTrack;
  isLast: boolean;
  /** True when this row's inline editor is open (state lives in SessionCard
   *  so ↑/↓ can move the editor between tracks). */
  editing: boolean;
  onStartEdit: () => void;
  onCloseEdit: () => void;
  /** Move the editor to the previous/next track of the session. */
  onNavigate: (delta: -1 | 1) => void;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  onTrackDelete?: (trackId: number) => Promise<void>;
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
  /** AI corrections that were applied to this track, if any. */
  corrections?: TrackCorrection[];
  onPreview: (state: PreviewState) => void;
}) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Seed the edit form from the CURRENT track — re-seeded each time the
  // editor opens, so a track whose titleEn/titlePt changed underneath us
  // (e.g. an AI-assist apply) shows the fresh values instead of the stale
  // mount-time snapshot.
  const seedFromTrack = () => ({
    title: track.title || "",
    titleEn: track.titleEn ?? "",
    titlePt: track.titlePt ?? "",
    titleEnReviewed: track.titleEnReviewed ?? true,
    titlePtReviewed: track.titlePtReviewed ?? true,
    originalFilename: track.originalFilename || "",
    languages: track.languages && track.languages.length > 0
      ? [...track.languages]
      : [track.originalLanguage || track.language || "en"],
    isPractice: track.isPractice || false,
    isTranslation: track.isTranslation || false,
    speaker: track.speaker || "",
  });
  const [editValues, setEditValues] = useState(seedFromTrack);
  const [speakerMenuAnchor, setSpeakerMenuAnchor] = useState<null | HTMLElement>(null);
  // Set once the editor's outcome is decided (save, cancel or navigate) so a
  // trailing blur event can't double-commit or clobber the next row's state.
  const doneRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ft = useFieldTranslate();

  useEffect(() => {
    if (editing) {
      setEditValues(seedFromTrack());
      doneRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const canEdit = Boolean(onTrackUpdate && track.id);

  // Determine icon — prefer the explicit mediaType discriminator (set by parser
  // for video tracks), falling back to format-based detection for legacy rows.
  const fileType = track.mediaType === "video"
    ? "video"
    : track.fileFormat
      ? getFileType(track.originalFilename)
      : "audio";
  const icon = getFileIcon(fileType);

  const isDirty = () => {
    const seed = seedFromTrack();
    return (
      editValues.titleEn !== seed.titleEn ||
      editValues.titlePt !== seed.titlePt ||
      editValues.titleEnReviewed !== seed.titleEnReviewed ||
      editValues.titlePtReviewed !== seed.titlePtReviewed ||
      editValues.speaker !== seed.speaker ||
      editValues.isPractice !== seed.isPractice ||
      editValues.isTranslation !== seed.isTranslation ||
      editValues.languages.join(",") !== seed.languages.join(",")
    );
  };

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (onTrackUpdate && track.id && isDirty()) {
      onTrackUpdate(track.id, {
        ...editValues,
        originalLanguage: editValues.languages[0] || "en",
      }).catch((error) => console.error("Failed to update track:", error));
    }
  };

  const saveAndClose = () => {
    commit();
    onCloseEdit();
  };

  const cancelEdit = () => {
    doneRef.current = true;
    onCloseEdit();
  };

  const saveAndNavigate = (delta: -1 | 1) => {
    commit();
    onNavigate(delta);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAndClose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      saveAndNavigate(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      saveAndNavigate(-1);
    }
  };

  const handleContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    // The speaker menu renders in a portal — focus moving into it must not
    // close the editor.
    if (speakerMenuAnchor) return;
    if (e.relatedTarget && containerRef.current?.contains(e.relatedTarget as Node)) return;
    saveAndClose();
  };

  const handleDelete = async () => {
    if (!onTrackDelete || !track.id) return;
    const confirmMsg = translate("padmakara.tracks.deleteConfirm", {
      title: cleanTitle(track),
    });
    if (!window.confirm(confirmMsg)) return;
    setDeleting(true);
    try {
      await onTrackDelete(track.id);
      // Caller is responsible for removing the row from local state +
      // surfacing the success notice; we just stay mounted long enough
      // to look responsive in case the parent doesn't unmount us.
    } catch {
      // Caller surfaces the error notification.
    } finally {
      setDeleting(false);
    }
  };

  const handleDownload = async () => {
    if (!track.id) return;
    setDownloading(true);
    try {
      const res = await authFetch(`/api/admin/tracks/${track.id}/download-url`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { url } = (await res.json()) as { url: string };
      // window.open with the same target avoids the popup blocker on a
      // user-initiated click and lets the Content-Disposition header drive
      // the actual download.
      window.location.href = url;
    } catch (err) {
      console.error("Track download failed:", err);
      notify(translate("padmakara.tracks.downloadFailed") || "Could not download track", {
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  if (editing) {
    return (
      <Box
        ref={containerRef}
        onBlur={handleContainerBlur}
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 0.6,
          px: 2,
          py: 1,
          borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.03)",
          backgroundColor: "rgba(91,94,166,0.03)",
        }}
      >
        {/* EN title line */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
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
            {String(track.trackNumber).padStart(2, "0")}
          </Typography>
          <LangTag code="en" />
          <InputBase
            autoFocus
            fullWidth
            value={editValues.titleEn}
            placeholder={translate("padmakara.events.titleEn")}
            onChange={(e) => setEditValues((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
            onKeyDown={handleEditKeyDown}
            sx={quietInputSx}
          />
          {!editValues.titleEnReviewed && (
            <AiReviewChip onClick={() => setEditValues((p) => ({ ...p, titleEnReviewed: true }))} />
          )}
          <TranslateDirChip
            direction="pt-to-en"
            disabled={!editValues.titlePt.trim()}
            pending={ft.translating}
            tooltip={translate("padmakara.events.translateToEn")}
            onClick={async () => {
              const out = await ft.translate(editValues.titlePt, "pt-to-en");
              if (out != null) setEditValues((p) => ({ ...p, titleEn: out, titleEnReviewed: false }));
            }}
          />
        </Box>

        {/* PT title line */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 24, flexShrink: 0 }} />
          <LangTag code="pt" />
          <InputBase
            fullWidth
            value={editValues.titlePt}
            placeholder={translate("padmakara.events.titlePt")}
            onChange={(e) => setEditValues((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
            onKeyDown={handleEditKeyDown}
            sx={quietInputSx}
          />
          {!editValues.titlePtReviewed && (
            <AiReviewChip onClick={() => setEditValues((p) => ({ ...p, titlePtReviewed: true }))} />
          )}
          <TranslateDirChip
            direction="en-to-pt"
            disabled={!editValues.titleEn.trim()}
            pending={ft.translating}
            tooltip={translate("padmakara.events.translateToPt")}
            onClick={async () => {
              const out = await ft.translate(editValues.titleEn, "en-to-pt");
              if (out != null) setEditValues((p) => ({ ...p, titlePt: out, titlePtReviewed: false }));
            }}
          />
        </Box>

        {/* Metadata line — the same chips as view mode, made toggleable */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", pl: "34px" }}>
          <Chip
            size="small"
            variant="outlined"
            label={`${editValues.speaker || translate("padmakara.tracks.speaker")} ▾`}
            onClick={(e) => setSpeakerMenuAnchor(e.currentTarget)}
            sx={{ height: 20, fontWeight: 600, "& .MuiChip-label": { px: 0.75, fontSize: "0.65rem" } }}
          />
          <Menu
            anchorEl={speakerMenuAnchor}
            open={Boolean(speakerMenuAnchor)}
            onClose={() => setSpeakerMenuAnchor(null)}
          >
            <MenuItem
              selected={!editValues.speaker}
              onClick={() => {
                setEditValues((p) => ({ ...p, speaker: "" }));
                setSpeakerMenuAnchor(null);
              }}
            >
              {translate("padmakara.tracks.noSpeaker")}
            </MenuItem>
            {allTeachers.map((t) => (
              <MenuItem
                key={t.id}
                selected={t.abbreviation === editValues.speaker}
                onClick={() => {
                  setEditValues((p) => ({ ...p, speaker: t.abbreviation }));
                  setSpeakerMenuAnchor(null);
                }}
              >
                {t.name} ({t.abbreviation})
              </MenuItem>
            ))}
          </Menu>

          {LANGUAGE_OPTIONS.map((lang) => {
            const active = editValues.languages.includes(lang);
            const lc = LANG_CHIP_COLORS[lang] || DEFAULT_LANG_CHIP;
            return (
              <Chip
                key={lang}
                size="small"
                label={languageLabel(lang)}
                onClick={() =>
                  setEditValues((p) => {
                    if (p.languages.includes(lang)) {
                      // Keep at least one language selected.
                      if (p.languages.length === 1) return p;
                      return { ...p, languages: p.languages.filter((l) => l !== lang) };
                    }
                    return { ...p, languages: [...p.languages, lang] };
                  })
                }
                sx={{
                  height: 20,
                  fontWeight: 600,
                  "& .MuiChip-label": { px: 0.6, fontSize: "0.65rem" },
                  ...(active
                    ? {
                        backgroundColor: lc.bg,
                        color: lc.text,
                        boxShadow: "inset 0 0 0 1.5px currentColor",
                        "&:hover": { backgroundColor: lc.bg },
                      }
                    : { backgroundColor: "rgba(0,0,0,0.04)", color: "text.disabled" }),
                }}
              />
            );
          })}

          <Chip
            size="small"
            icon={<SelfImprovementIcon sx={{ fontSize: "12px !important" }} />}
            label="Practice"
            onClick={() => setEditValues((p) => ({ ...p, isPractice: !p.isPractice }))}
            sx={{
              height: 20,
              fontWeight: 600,
              "& .MuiChip-label": { px: 0.6, fontSize: "0.65rem" },
              ...(editValues.isPractice
                ? {
                    backgroundColor: "rgba(156,39,176,0.1)",
                    color: "#9c27b0",
                    boxShadow: "inset 0 0 0 1.5px currentColor",
                    "& .MuiChip-icon": { color: "#9c27b0" },
                    "&:hover": { backgroundColor: "rgba(156,39,176,0.1)" },
                  }
                : {
                    backgroundColor: "rgba(0,0,0,0.04)",
                    color: "text.disabled",
                    "& .MuiChip-icon": { color: "text.disabled" },
                  }),
            }}
          />
          <Chip
            size="small"
            icon={<TranslateIcon sx={{ fontSize: "12px !important" }} />}
            label={translate("padmakara.session.translation")}
            onClick={() => setEditValues((p) => ({ ...p, isTranslation: !p.isTranslation }))}
            sx={{
              height: 20,
              fontWeight: 600,
              "& .MuiChip-label": { px: 0.6, fontSize: "0.65rem" },
              ...(editValues.isTranslation
                ? {
                    backgroundColor: "rgba(212,168,83,0.12)",
                    color: "secondary.dark",
                    boxShadow: "inset 0 0 0 1.5px currentColor",
                    "& .MuiChip-icon": { color: "secondary.dark" },
                    "&:hover": { backgroundColor: "rgba(212,168,83,0.12)" },
                  }
                : {
                    backgroundColor: "rgba(0,0,0,0.04)",
                    color: "text.disabled",
                    "& .MuiChip-icon": { color: "text.disabled" },
                  }),
            }}
          />

          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ color: "text.disabled", fontSize: "0.65rem" }}>
            {translate("padmakara.tracks.editKeyHint")}
          </Typography>
          {editValues.originalFilename && (
            <Tooltip
              title={
                <Box component="span" sx={{ fontFamily: "monospace", fontSize: 11 }}>
                  {editValues.originalFilename}
                </Box>
              }
            >
              {/* IconButton (focusable) so hovering/clicking it keeps focus
                  inside the editor instead of blurring it closed. */}
              <IconButton size="small" sx={{ p: 0.25, color: "text.disabled" }}>
                <InfoOutlinedIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1,
        borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.03)",
        "&:hover": {
          backgroundColor: canEdit
            ? "rgba(91,94,166,0.02)"
            : "rgba(0,0,0,0.01)",
        },
      }}
    >
      {/* Track number */}
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
        {String(track.trackNumber).padStart(2, "0")}
      </Typography>

      {/* Icon */}
      <Box
        sx={{
          color: track.isTranslation ? "secondary.main" : "primary.light",
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>

      {/* Title — cleaned of speaker prefix. Clicking it opens the inline
          editor in place (when the track is saved and editable). */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          noWrap
          title={canEdit ? translate("padmakara.tracks.clickToEdit") : undefined}
          onClick={canEdit ? onStartEdit : undefined}
          sx={{
            fontWeight: track.isTranslation ? 400 : 500,
            display: "inline-block",
            maxWidth: "100%",
            verticalAlign: "middle",
            ...(canEdit ? clickToEditSx : {}),
          }}
        >
          {cleanTitle(track)}
        </Typography>
      </Box>

      {/* AI corrections badge */}
      {corrections && corrections.length > 0 && (
        <TrackCorrectionsBadge corrections={corrections} />
      )}

      {/* Badges */}
      {/* Practice badge — special purple/meditation theme */}
      {track.isPractice && (
        <Chip
          icon={<SelfImprovementIcon sx={{ fontSize: "12px !important" }} />}
          label="Practice"
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(156,39,176,0.1)",
            color: "#9c27b0",
            "& .MuiChip-label": {
              fontSize: "0.65rem",
              px: 0.5,
              fontWeight: 600,
            },
          }}
        />
      )}

      {track.isTranslation && (
        <Chip
          icon={<TranslateIcon sx={{ fontSize: "12px !important" }} />}
          label={translate("padmakara.session.translation")}
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(212,168,83,0.1)",
            color: "secondary.dark",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
          }}
        />
      )}

      {/* Speaker chip — before file format */}
      {track.speaker && (
        <Chip
          label={track.speaker}
          size="small"
          variant="outlined"
          sx={{
            height: 20,
            "& .MuiChip-label": {
              fontSize: "0.65rem",
              px: 0.5,
              fontWeight: 600,
            },
          }}
        />
      )}

      {/* File format badge — subtle gray */}
      {track.fileFormat && (
        <Chip
          label={track.fileFormat.toUpperCase()}
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(0,0,0,0.04)",
            color: "text.secondary",
            "& .MuiChip-label": {
              fontSize: "0.6rem",
              px: 0.5,
              fontWeight: 600,
              fontFamily: "monospace",
            },
          }}
        />
      )}

      {(track.languages && track.languages.length > 0 ? track.languages : [track.originalLanguage || track.language || "en"]).map((lang) => {
        const lc = LANG_CHIP_COLORS[lang.toLowerCase()] || DEFAULT_LANG_CHIP;
        return (
          <Chip
            key={lang}
            label={languageLabel(lang)}
            size="small"
            sx={{
              height: 20,
              backgroundColor: lc.bg,
              color: lc.text,
              "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 },
            }}
          />
        );
      })}

      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontSize: "0.7rem",
          minWidth: 50,
          textAlign: "right",
        }}
      >
        {formatFileSize(track.file.size)}
      </Typography>

      {/* Play button — only show for saved (DB-backed) tracks */}
      {track.id && (
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onPreview({
              source: {
                kind: "track",
                trackId: track.id!,
                mediaType: track.mediaType === "video" ? "video" : "audio",
              },
              title: cleanTitle(track),
            });
          }}
          sx={{ opacity: 0.5, "&:hover": { opacity: 1, color: "primary.main" } }}
          title={translate("padmakara.session.trackPlay") || "Play"}
        >
          <PlayArrowIcon sx={{ fontSize: 18 }} />
        </IconButton>
      )}

      {/* Download button — fetches a fresh presigned URL and triggers a
          browser download with the track's title as filename. */}
      {track.id && (
        <IconButton
          size="small"
          onClick={handleDownload}
          disabled={downloading}
          sx={{ opacity: 0.5, "&:hover": { opacity: 1, color: "primary.main" } }}
          title={translate("padmakara.tracks.download") || "Download audio"}
        >
          <DownloadIcon sx={{ fontSize: 16 }} />
        </IconButton>
      )}

      {/* Delete button — only on edit-mode rows that have a DB id */}
      {onTrackDelete && track.id && (
        <IconButton
          size="small"
          onClick={handleDelete}
          disabled={deleting}
          sx={{
            opacity: 0.4,
            "&:hover": { opacity: 1, color: "error.main" },
          }}
          title={translate("padmakara.tracks.delete") || "Delete track"}
        >
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Box>
  );
};

/* ───────── AI corrections badge (import-only, stateless parent + collapsible) ───────── */

/**
 * Small inline badge that shows how many AI corrections were applied to a
 * track, with an expandable diff panel listing each correction.
 * Only rendered when corrections.length > 0.
 */
const TrackCorrectionsBadge = ({
  corrections,
}: {
  corrections: TrackCorrection[];
}) => {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      <Chip
        icon={<AutoAwesomeIcon sx={{ fontSize: "12px !important" }} />}
        label={`${corrections.length} AI fix${corrections.length === 1 ? "" : "es"}`}
        size="small"
        color="warning"
        variant="outlined"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        deleteIcon={open ? <ExpandLessIcon sx={{ fontSize: "14px !important" }} /> : <ExpandMoreIcon sx={{ fontSize: "14px !important" }} />}
        onDelete={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        sx={{
          height: 20,
          cursor: "pointer",
          "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 },
        }}
      />
      <Collapse in={open} unmountOnExit>
        <Box
          sx={{
            mt: 0.5,
            p: 1,
            borderRadius: 1,
            backgroundColor: "rgba(237,108,2,0.05)",
            border: "1px solid rgba(237,108,2,0.15)",
            minWidth: 260,
            maxWidth: 400,
          }}
        >
          {corrections.map((c, i) => (
            <Box key={i} sx={{ display: "flex", flexDirection: "column", gap: 0.25, mb: i < corrections.length - 1 ? 1 : 0 }}>
              <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary", fontSize: "0.6rem" }}>
                {c.field}
              </Typography>
              <Typography variant="caption" sx={{ fontSize: "0.7rem" }}>
                <Box component="span" sx={{ color: "error.main", textDecoration: "line-through", mr: 0.5 }}>
                  {c.before}
                </Box>
                {"→ "}
                <Box component="span" sx={{ color: "success.dark" }}>
                  {c.after}
                </Box>
              </Typography>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};
