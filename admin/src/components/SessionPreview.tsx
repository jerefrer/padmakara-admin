import { useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Collapse from "@mui/material/Collapse";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import TranslateIcon from "@mui/icons-material/Translate";
import EditIcon from "@mui/icons-material/Edit";
import CheckIcon from "@mui/icons-material/Check";
import CalendarTodayIcon from "@mui/icons-material/CalendarToday";
import { useTranslate } from "react-admin";
import { type InferredSession, type ParsedTrack, formatFileSize, languageLabel } from "../utils/trackParser";

interface SessionPreviewProps {
  sessions: InferredSession[];
  onSessionTitleChange: (sessionIndex: number, title: string) => void;
}

export const SessionPreview = ({ sessions, onSessionTitleChange }: SessionPreviewProps) => {
  if (sessions.length === 0) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {sessions.map((session, idx) => (
        <SessionCard
          key={idx}
          session={session}
          index={idx}
          onTitleChange={(title) => onSessionTitleChange(idx, title)}
        />
      ))}
    </Box>
  );
};

interface SessionCardProps {
  session: InferredSession;
  index: number;
  onTitleChange: (title: string) => void;
}

const SessionCard = ({ session, index, onTitleChange }: SessionCardProps) => {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.titleEn);
  const translate = useTranslate();

  // Build date chip label with AM/PM inline
  const dateLabel = (() => {
    if (!session.date) return null;
    const period = session.timePeriod === "morning" ? " AM" : session.timePeriod === "afternoon" || session.timePeriod === "evening" ? " PM" : "";
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
          {translate("padmakara.session.session", { number: session.sessionNumber })}
        </Box>

        {editing ? (
          <TextField
            size="small"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            sx={{ flex: 1, "& .MuiInputBase-input": { fontSize: "0.88rem", py: 0.5 } }}
          />
        ) : (
          <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
            {session.titleEn}
          </Typography>
        )}

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {/* Edit button — left of date chip */}
          {editing ? (
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); handleSaveTitle(); }}>
              <CheckIcon sx={{ fontSize: 16 }} />
            </IconButton>
          ) : (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); setEditing(true); }}
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
              sx={{ height: 24, "& .MuiChip-label": { fontSize: "0.7rem", px: 0.8 } }}
            />
          )}

          <Chip
            label={translate("padmakara.session.tracks", { count: session.tracks.length })}
            size="small"
            sx={{
              height: 24,
              backgroundColor: "rgba(91,94,166,0.08)",
              "& .MuiChip-label": { fontSize: "0.7rem", px: 0.8, fontWeight: 600 },
            }}
          />

          <IconButton size="small" onClick={() => setExpanded(!expanded)} sx={{ ml: -0.5 }}>
            {expanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        </Box>
      </Box>

      {/* Track list */}
      <Collapse in={expanded}>
        <Box>
          {session.tracks.map((track, tidx) => (
            <TrackRow key={tidx} track={track} isLast={tidx === session.tracks.length - 1} />
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

const TrackRow = ({ track, isLast }: { track: ParsedTrack; isLast: boolean }) => {
  const translate = useTranslate();
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
      <AudioFileIcon
        sx={{
          fontSize: 16,
          color: track.isTranslation ? "secondary.main" : "primary.light",
          flexShrink: 0,
        }}
      />

      {/* Title — cleaned of speaker prefix */}
      <Typography variant="body2" sx={{ flex: 1, fontWeight: track.isTranslation ? 400 : 500 }} noWrap>
        {cleanTitle(track)}
      </Typography>

      {/* Badges */}
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

      {/* Speaker chip — before language */}
      {track.speaker && (
        <Chip
          label={track.speaker}
          size="small"
          variant="outlined"
          sx={{ height: 20, "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 } }}
        />
      )}

      <Chip
        label={languageLabel(track.language)}
        size="small"
        sx={{
          height: 20,
          backgroundColor: "rgba(91,94,166,0.06)",
          "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
        }}
      />

      <Typography variant="caption" sx={{ color: "text.secondary", fontSize: "0.7rem", minWidth: 50, textAlign: "right" }}>
        {formatFileSize(track.file.size)}
      </Typography>
    </Box>
  );
};
