import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import LinearProgress from "@mui/material/LinearProgress";
import Button from "@mui/material/Button";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import { useTranslate } from "react-admin";
import type { UploadProgress as UploadProgressData, FileStatus } from "../utils/uploadManager";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(bytesRemaining: number, speed: number, translate: (key: string, options?: any) => string): string {
  if (speed <= 0) return translate("padmakara.upload.estimating");
  const seconds = bytesRemaining / speed;
  if (seconds < 60) return translate("padmakara.upload.secondsRemaining", { seconds: Math.ceil(seconds) });
  if (seconds < 3600) return translate("padmakara.upload.minutesRemaining", { minutes: Math.ceil(seconds / 60) });
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return translate("padmakara.upload.hoursRemaining", { hours: h, minutes: m });
}

function FileRow({ file, speed }: { file: FileStatus; speed: number }) {
  const icon =
    file.status === "done" ? <CheckCircleIcon sx={{ fontSize: 16, color: "success.main" }} /> :
    file.status === "error" ? <ErrorIcon sx={{ fontSize: 16, color: "error.main" }} /> :
    file.status === "uploading" ? <CloudUploadIcon sx={{ fontSize: 16, color: "primary.main" }} /> :
    <HourglassEmptyIcon sx={{ fontSize: 16, color: "text.disabled" }} />;

  return (
    <Box
      sx={{
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        bgcolor: file.status === "uploading" ? "action.hover" : "transparent",
        opacity: file.status === "pending" ? 0.6 : 1,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        {icon}
        <Typography
          variant="body2"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.8rem",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.filename}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {formatBytes(file.size)}
        </Typography>
      </Box>
      {file.status === "uploading" && (
        <Box sx={{ mt: 0.5, ml: 3 }}>
          <LinearProgress
            variant="determinate"
            value={file.progress * 100}
            sx={{ height: 3, borderRadius: 1 }}
          />
          <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.2 }}>
            <Typography variant="caption" color="text.secondary">
              {Math.round(file.progress * 100)}%
            </Typography>
            {speed > 0 && (
              <Typography variant="caption" color="text.secondary">
                {formatBytes(speed)}/s
              </Typography>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

interface UploadProgressProps {
  progress: UploadProgressData;
  onCancel: () => void;
}

export const UploadProgress = ({ progress, onCancel }: UploadProgressProps) => {
  const translate = useTranslate();
  const {
    phase, currentFilename, fileProgress,
    filesCompleted, filesTotal,
    bytesUploaded, bytesTotal, speed, error,
  } = progress;

  const overallPercent = bytesTotal > 0 ? (bytesUploaded / bytesTotal) * 100 : 0;
  const bytesRemaining = bytesTotal - bytesUploaded;

  if (phase === "done") {
    return (
      <Paper sx={{ p: 4, textAlign: "center" }}>
        <CheckCircleIcon sx={{ fontSize: 48, color: "success.main", mb: 1 }} />
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
          {translate("padmakara.upload.complete")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {translate("padmakara.upload.filesUploaded", { count: filesTotal, size: formatBytes(bytesTotal), smart_count: filesTotal })}
        </Typography>
      </Paper>
    );
  }

  if (phase === "error") {
    return (
      <Paper sx={{ p: 4, textAlign: "center" }}>
        <ErrorIcon sx={{ fontSize: 48, color: "error.main", mb: 1 }} />
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5, color: "error.main" }}>
          {translate("padmakara.upload.failed")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {error || "An unexpected error occurred"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {translate("padmakara.upload.failedFilesNote", { completed: filesCompleted, total: filesTotal })}
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 3 }}>
      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2.5 }}>
        <CloudUploadIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" sx={{ fontWeight: 600, flex: 1 }}>
          {phase === "presigning" ? translate("padmakara.upload.preparing") : translate("padmakara.upload.uploading")}
        </Typography>
        <Button size="small" color="inherit" onClick={onCancel} sx={{ color: "text.secondary" }}>
          {translate("padmakara.upload.cancel")}
        </Button>
      </Box>

      {/* Overall progress */}
      <Box sx={{ mb: 2.5 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {translate("padmakara.upload.filesProgress", { completed: filesCompleted, total: filesTotal })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatBytes(bytesUploaded)} / {formatBytes(bytesTotal)}
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={overallPercent}
          sx={{ height: 8, borderRadius: 1, mb: 0.5 }}
        />
        <Box sx={{ display: "flex", justifyContent: "space-between" }}>
          <Typography variant="caption" color="text.secondary">
            {Math.round(overallPercent)}%
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {phase === "uploading" ? formatEta(bytesRemaining, speed, translate) : ""}
          </Typography>
        </Box>
      </Box>

      {/* File list */}
      {progress.files && progress.files.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          {progress.files.map((file) => (
            <FileRow key={file.filename} file={file} speed={file.status === "uploading" ? speed : 0} />
          ))}
        </Box>
      )}
    </Paper>
  );
};
