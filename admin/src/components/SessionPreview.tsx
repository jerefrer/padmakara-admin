import AudioFileIcon from "@mui/icons-material/AudioFile";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import CheckIcon from "@mui/icons-material/Check";
import DescriptionIcon from "@mui/icons-material/Description";
import EditIcon from "@mui/icons-material/Edit";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
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
import { useState } from "react";
import { useTranslate } from "react-admin";
import {
  type InferredSession,
  type ParsedTrack,
  formatFileSize,
  languageLabel,
} from "../utils/trackParser";

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
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
}

export const SessionPreview = ({
  sessions,
  onSessionTitleChange,
  onTrackUpdate,
  allTeachers,
}: SessionPreviewProps) => {
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
              allTeachers={allTeachers}
            />
          ))}
        </Box>
      </Paper>
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
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
}

const SessionCard = ({
  session,
  index,
  onTitleChange,
  onTrackUpdate,
  allTeachers,
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
          {session.tracks.map((track, tidx) => (
            <TrackRow
              key={tidx}
              track={track}
              isLast={tidx === session.tracks.length - 1}
              onTrackUpdate={onTrackUpdate}
              allTeachers={allTeachers}
            />
          ))}
        </Box>
      </Collapse>
    </Paper>
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
  allTeachers = [],
}: {
  track: ParsedTrack;
  isLast: boolean;
  onTrackUpdate?: (
    trackId: number,
    updates: Partial<ParsedTrack>,
  ) => Promise<void>;
  allTeachers?: Array<{ id: number; name: string; abbreviation: string }>;
}) => {
  const translate = useTranslate();
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState({
    originalFilename: track.originalFilename || "",
    languages: track.languages && track.languages.length > 0
      ? [...track.languages]
      : [track.originalLanguage || track.language || "en"],
    isPractice: track.isPractice || false,
    isTranslation: track.isTranslation || false,
    speaker: track.speaker || "",
  });
  const [saving, setSaving] = useState(false);

  // Determine icon based on file format
  const fileType = track.fileFormat
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

          <TextField
            size="small"
            label="Filename"
            value={editValues.originalFilename}
            onChange={(e) =>
              setEditValues({ ...editValues, originalFilename: e.target.value })
            }
            sx={{ flex: 1 }}
          />
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
    </Box>
  );
};
