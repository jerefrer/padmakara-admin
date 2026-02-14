import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import VideoFileIcon from "@mui/icons-material/VideoFile";
import DescriptionIcon from "@mui/icons-material/Description";
import TranslateIcon from "@mui/icons-material/Translate";
import { type ParsedTrack, formatFileSize, languageLabel } from "../utils/trackParser";

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
  eventFiles: any[];
}

export const EventFilesPreview = ({ transcripts, eventFiles }: EventFilesPreviewProps) => {
  if (transcripts.length === 0 && eventFiles.length === 0) return null;

  // Convert transcripts to tracks for display
  const transcriptTracks: ParsedTrack[] = transcripts.map((t, idx) => ({
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
  }));

  // Group event files by type
  const eventFilesByType = new Map<string, ParsedTrack[]>();
  for (const ef of eventFiles) {
    const type = ef.fileType || "other";
    if (!eventFilesByType.has(type)) {
      eventFilesByType.set(type, []);
    }

    const track: ParsedTrack = {
      trackNumber: 0,
      title: ef.originalFilename || `File ${eventFilesByType.get(type)!.length + 1}`,
      speaker: null,
      languages: ef.languages || [ef.language || "unknown"],
      originalLanguage: ef.originalLanguage || ef.language || "unknown",
      isTranslation: false,
      originalFilename: ef.originalFilename || null,
      partNumber: null,
      file: { name: ef.originalFilename || "file", size: ef.fileSizeBytes || 0 } as File,
      date: null,
      timePeriod: null,
      isPractice: false,
      fileFormat: ef.originalFilename ? ef.originalFilename.split(".").pop()?.toLowerCase() : null,
    };

    eventFilesByType.get(type)!.push(track);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, mb: 3 }}>
      {/* Event-level transcripts */}
      {transcriptTracks.length > 0 && (
        <FileSection
          title="Transcripts"
          icon={<PictureAsPdfIcon />}
          tracks={transcriptTracks}
        />
      )}

      {/* Event-level files grouped by type */}
      {Array.from(eventFilesByType.entries()).map(([type, tracks]) => (
        <FileSection
          key={type}
          title={`${type.charAt(0).toUpperCase() + type.slice(1)} Files`}
          icon={<DescriptionIcon />}
          tracks={tracks}
        />
      ))}
    </Box>
  );
};

interface FileSectionProps {
  title: string;
  icon: React.ReactNode;
  tracks: ParsedTrack[];
}

const FileSection = ({ title, icon, tracks }: FileSectionProps) => {
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
}: {
  track: ParsedTrack;
  isLast: boolean;
}) => {
  const fileType = track.fileFormat ? getFileType(track.originalFilename) : "other";
  const icon = getFileIcon(fileType);

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
            backgroundColor: "rgba(91,94,166,0.06)",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
          }}
        />
      ))}

      {/* File size */}
      <Typography variant="caption" sx={{ color: "text.secondary", fontSize: "0.7rem", minWidth: 50, textAlign: "right" }}>
        {formatFileSize(track.file.size)}
      </Typography>
    </Box>
  );
};
