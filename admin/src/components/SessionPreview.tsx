import AddIcon from "@mui/icons-material/Add";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import CheckIcon from "@mui/icons-material/Check";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DescriptionIcon from "@mui/icons-material/Description";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MovieIcon from "@mui/icons-material/Movie";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SelfImprovementIcon from "@mui/icons-material/SelfImprovement";
import TranslateIcon from "@mui/icons-material/Translate";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import {
  type InferredSession,
  type ParsedTrack,
  formatFileSize,
  languageLabel,
} from "../utils/trackParser";
import type { TrackCorrection } from "../utils/analyzeFolder";
import { MediaPreviewDialog } from "./MediaPreviewDialog";

/** Map keyed by track's originalFilename → list of corrections applied to it. */
export type TrackCorrectionsMap = Map<string, TrackCorrection[]>;

type PreviewSource =
  | { kind: "track"; trackId: number; mediaType: "audio" | "video" }
  | { kind: "session-video"; sessionId: number };

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
  onSessionTitleChange: (sessionIndex: number, title: string) => void;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  /** Edit-mode only: deletes the track row + its S3 audio (and read-along
   *  JSON). Confirmation is handled by the row before this fires. */
  onTrackDelete?: (trackId: number) => Promise<void>;
  /** Edit-mode only: triggered when admin picks a new video file for a session. */
  onSessionVideoUpload?: (sessionId: number, file: File) => void;
  /** Edit-mode only: detach + ref-counted Bunny cleanup. */
  onSessionVideoDelete?: (sessionId: number) => Promise<void>;
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
              onTitleChange={(title) => onSessionTitleChange(idx, title)}
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
  onTitleChange: (title: string) => void;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  onTrackDelete?: (trackId: number) => Promise<void>;
  onSessionVideoUpload?: (sessionId: number, file: File) => void;
  onSessionVideoDelete?: (sessionId: number) => Promise<void>;
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
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.titleEn);
  const translate = useTranslate();

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

  const handleSaveTitle = () => {
    onTitleChange(editTitle);
    setEditing(false);
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
        onClick={() => !editing && setExpanded(!expanded)}
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

        {editing ? (
          <TextField
            size="small"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            sx={{
              flex: 1,
              "& .MuiInputBase-input": { fontSize: "0.88rem", py: 0.5 },
            }}
          />
        ) : (
          <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
            {session.titleEn}
          </Typography>
        )}

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {/* Edit button — left of date chip */}
          {editing ? (
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                handleSaveTitle();
              }}
            >
              <CheckIcon sx={{ fontSize: 16 }} />
            </IconButton>
          ) : (
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              sx={{ opacity: 0.4, "&:hover": { opacity: 1 } }}
            >
              <EditIcon sx={{ fontSize: 14 }} />
            </IconButton>
          )}

          {/* Video presence badge — shown when this session has a Bunny video. */}
          {session.bunnyVideoId && (
            <Chip
              icon={<MovieIcon sx={{ fontSize: "12px !important" }} />}
              label={
                session.videoDurationSeconds
                  ? formatDuration(session.videoDurationSeconds)
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
          {/* Video row — only meaningful in edit mode where session.id exists. */}
          {session.id && (onSessionVideoUpload || onSessionVideoDelete) && (
            <SessionVideoRow
              sessionId={session.id}
              bunnyVideoId={session.bunnyVideoId ?? null}
              durationSeconds={session.videoDurationSeconds ?? null}
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

interface SessionVideoRowProps {
  sessionId: number;
  bunnyVideoId: string | null;
  durationSeconds: number | null;
  onUpload?: (sessionId: number, file: File) => void;
  onDelete?: (sessionId: number) => Promise<void>;
  hasFollowingTracks: boolean;
  sessionTitle: string;
  onPreview: (state: PreviewState) => void;
}

const SessionVideoRow = ({
  sessionId,
  bunnyVideoId,
  durationSeconds,
  onUpload,
  onDelete,
  hasFollowingTracks,
  sessionTitle,
  onPreview,
}: SessionVideoRowProps) => {
  const translate = useTranslate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [deleting, setDeleting] = useState(false);

  const triggerPicker = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again still fires
    if (file && onUpload) onUpload(sessionId, file);
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm(translate("padmakara.session.videoDeleteConfirm") || "Detach this video and delete it from Bunny? This cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      await onDelete(sessionId);
    } finally {
      setDeleting(false);
    }
  };

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
        borderBottom: hasFollowingTracks ? "1px dashed rgba(0,0,0,0.06)" : "none",
        backgroundColor: bunnyVideoId ? "rgba(220, 53, 69, 0.025)" : "transparent",
      }}
    >
      <Box sx={{ color: bunnyVideoId ? "#b91c1c" : "text.disabled", display: "flex" }}>
        {bunnyVideoId ? <MovieIcon sx={{ fontSize: 18 }} /> : <VideoFileIcon sx={{ fontSize: 18 }} />}
      </Box>

      {bunnyVideoId ? (
        <>
          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.85rem" }}>
            {translate("padmakara.session.videoAttached") || "Video recording attached"}
          </Typography>
          <Chip
            label={durationSeconds ? formatDuration(durationSeconds) : translate("padmakara.session.videoTranscoding") || "Transcoding…"}
            size="small"
            variant="outlined"
            sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.68rem", px: 0.8 } }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1, fontFamily: "monospace" }}>
            {bunnyVideoId.slice(0, 8)}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <IconButton
            size="small"
            onClick={() =>
              onPreview({
                source: { kind: "session-video", sessionId },
                title: sessionTitle,
              })
            }
            sx={{ color: "#b91c1c" }}
            title={translate("padmakara.session.videoPlay") || "Play"}
          >
            <PlayArrowIcon sx={{ fontSize: 20 }} />
          </IconButton>
          {onUpload && (
            <Button
              size="small"
              startIcon={<EditIcon sx={{ fontSize: 14 }} />}
              onClick={triggerPicker}
              disabled={deleting}
              sx={{ textTransform: "none", fontSize: "0.75rem" }}
            >
              {translate("padmakara.session.videoReplace") || "Replace"}
            </Button>
          )}
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
        </>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.85rem", fontStyle: "italic" }}>
            {translate("padmakara.session.videoNone") || "No video recording"}
          </Typography>
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
        </>
      )}

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

/** Strip any remaining "SPEAKER - " prefix from title for display */
function cleanTitle(track: ParsedTrack): string {
  let t = track.title;
  if (track.speaker) {
    t = t
      .replace(new RegExp(`^${track.speaker}\\s*-\\s+`, "i"), "")
      .replace(new RegExp(`^${track.speaker}\\s*-\\s*`, "i"), "")
      .replace(new RegExp(`^${track.speaker}\\s+`, "i"), "");
  }
  // Fallback: strip any leading 2-5 letter abbreviation + " - " pattern
  t = t.replace(/^[A-Z]{2,5}\s*-\s+/i, "");
  // Also strip any TRAD prefix that might remain
  t = t.replace(/^TRAD\s*-\s+/i, "").replace(/^TRAD\s+/i, "");
  return t || track.title;
}

const TrackRow = ({
  track,
  isLast,
  onTrackUpdate,
  onTrackDelete,
  allTeachers = [],
  corrections,
  onPreview,
}: {
  track: ParsedTrack;
  isLast: boolean;
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
  const [editing, setEditing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editValues, setEditValues] = useState({
    title: track.title || "",
    originalFilename: track.originalFilename || "",
    languages: track.languages && track.languages.length > 0
      ? [...track.languages]
      : [track.originalLanguage || track.language || "en"],
    isPractice: track.isPractice || false,
    isTranslation: track.isTranslation || false,
    speaker: track.speaker || "",
  });
  const [saving, setSaving] = useState(false);

  // Determine icon — prefer the explicit mediaType discriminator (set by parser
  // for video tracks), falling back to format-based detection for legacy rows.
  const fileType = track.mediaType === "video"
    ? "video"
    : track.fileFormat
      ? getFileType(track.originalFilename)
      : "audio";
  const icon = getFileIcon(fileType);

  const handleSave = async () => {
    if (!onTrackUpdate || !track.id) return;

    setSaving(true);
    try {
      await onTrackUpdate(track.id, {
        ...editValues,
        originalLanguage: editValues.languages[0] || "en",
      });
      setEditing(false);
    } catch (error) {
      console.error("Failed to update track:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValues({
      title: track.title || "",
      originalFilename: track.originalFilename || "",
      languages: track.languages && track.languages.length > 0
        ? [...track.languages]
        : [track.originalLanguage || track.language || "en"],
      isPractice: track.isPractice || false,
      isTranslation: track.isTranslation || false,
      speaker: track.speaker || "",
    });
    setEditing(false);
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
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
          px: 2,
          py: 2,
          borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.03)",
          backgroundColor: "rgba(91,94,166,0.02)",
        }}
      >
        {/* Edit form */}
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
          <Typography
            variant="caption"
            sx={{
              width: 24,
              textAlign: "right",
              color: "text.secondary",
              fontFamily: "monospace",
              fontWeight: 600,
            }}
          >
            {String(track.trackNumber).padStart(2, "0")}
          </Typography>

          <Box sx={{ display: "flex", flexDirection: "column", gap: 1, flex: 1 }}>
            <TextField
              size="small"
              label="Title"
              value={editValues.title}
              onChange={(e) =>
                setEditValues({ ...editValues, title: e.target.value })
              }
              autoFocus
              helperText="Shown to users in the mobile app"
            />
            <TextField
              size="small"
              label="Source filename (read-only)"
              value={editValues.originalFilename}
              InputProps={{ readOnly: true }}
              sx={{
                "& .MuiInputBase-input": { color: "text.secondary", fontFamily: "monospace", fontSize: 12 },
              }}
              helperText="Original filename from upload, kept for admin reference. Editing has no effect on the S3 object or what users see."
            />
          </Box>
        </Box>

        <Box sx={{ display: "flex", gap: 1.5, ml: "40px" }}>
          <Autocomplete
            multiple
            size="small"
            options={["en", "pt", "fr", "tib"]}
            getOptionLabel={(option) => languageLabel(option)}
            value={editValues.languages}
            onChange={(_, value) =>
              setEditValues({ ...editValues, languages: value.length > 0 ? value : ["en"] })
            }
            disableCloseOnSelect
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip
                  {...getTagProps({ index })}
                  key={option}
                  label={languageLabel(option)}
                  size="small"
                  sx={{ height: 20, "& .MuiChip-label": { fontSize: "0.7rem" } }}
                />
              ))
            }
            renderInput={(params) => (
              <TextField {...params} label="Languages" placeholder="Add..." />
            )}
            sx={{ minWidth: 180 }}
          />

          <Autocomplete
            size="small"
            options={allTeachers}
            getOptionLabel={(option) =>
              `${option.name} (${option.abbreviation})`
            }
            value={
              allTeachers.find((t) => t.abbreviation === editValues.speaker) ||
              null
            }
            onChange={(_, value) =>
              setEditValues({
                ...editValues,
                speaker: value ? value.abbreviation : "",
              })
            }
            isOptionEqualToValue={(option, value) =>
              option.abbreviation === value.abbreviation
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Speaker"
                placeholder="Select teacher..."
              />
            )}
            sx={{ width: 200 }}
          />

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={editValues.isPractice}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setEditValues({ ...editValues, isPractice: e.target.checked })
                }
              />
            }
            label={<Typography variant="caption">Practice</Typography>}
          />

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={editValues.isTranslation}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setEditValues({
                    ...editValues,
                    isTranslation: e.target.checked,
                  })
                }
              />
            }
            label={<Typography variant="caption">Translation</Typography>}
          />

          <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
            <Button size="small" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </Box>
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
          backgroundColor: onTrackUpdate
            ? "rgba(91,94,166,0.02)"
            : "rgba(0,0,0,0.01)",
          cursor: onTrackUpdate ? "pointer" : "default",
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

      {/* Title — cleaned of speaker prefix */}
      <Typography
        variant="body2"
        sx={{ flex: 1, fontWeight: track.isTranslation ? 400 : 500 }}
        noWrap
      >
        {cleanTitle(track)}
      </Typography>

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

      {/* Edit button — only show if onTrackUpdate is provided */}
      {onTrackUpdate && (
        <IconButton
          size="small"
          onClick={() => setEditing(true)}
          sx={{ opacity: 0.4, "&:hover": { opacity: 1 } }}
        >
          <EditIcon sx={{ fontSize: 14 }} />
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
        icon={<AutoFixHighIcon sx={{ fontSize: "12px !important" }} />}
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
