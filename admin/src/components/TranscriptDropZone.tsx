/**
 * TranscriptDropZone — PDF file drop target for transcript uploads.
 *
 * Accepts PDF files via drag-and-drop or file-picker click.
 * Calls `onFilesDropped` with the selected File objects so the
 * parent can drive presign → S3-PUT → DB record creation.
 */

import { useCallback, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { useTranslate } from "react-admin";

export interface TranscriptUploadState {
  filename: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number; // 0-1
  error?: string;
}

interface TranscriptDropZoneProps {
  /** Called when the user drops or selects PDF files. */
  onFilesDropped: (files: File[]) => void;
  /** Upload state for each file (driven by parent). */
  uploads?: TranscriptUploadState[];
  /** Whether uploading is in progress (disables new drops). */
  disabled?: boolean;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

export const TranscriptDropZone = ({
  onFilesDropped,
  uploads = [],
  disabled = false,
}: TranscriptDropZoneProps) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const translate = useTranslate();

  const handleFiles = useCallback(
    (files: File[]) => {
      const pdfs = files.filter(isPdfFile);
      if (pdfs.length === 0) return;
      onFilesDropped(pdfs);
    },
    [onFilesDropped],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragOver(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    },
    [disabled, handleFiles],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      handleFiles(files);
      // Reset so the same file can be re-selected if needed
      e.target.value = "";
    },
    [handleFiles],
  );

  const hasDoneUploads = uploads.some((u) => u.status === "done");
  const hasErrorUploads = uploads.some((u) => u.status === "error");
  const hasUploads = uploads.length > 0;
  const isUploading = uploads.some((u) => u.status === "uploading");

  return (
    <Box>
      <Box
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
        sx={{
          border: "2px dashed",
          borderColor: isDragOver
            ? "primary.main"
            : hasDoneUploads
              ? "success.main"
              : hasErrorUploads
                ? "error.main"
                : "rgba(0,0,0,0.12)",
          borderRadius: 2,
          p: hasUploads ? 2 : 3,
          textAlign: "center",
          cursor: disabled || isUploading ? "default" : "pointer",
          transition: "all 0.2s ease",
          backgroundColor: isDragOver
            ? "rgba(91,94,166,0.04)"
            : hasDoneUploads
              ? "rgba(107,175,141,0.04)"
              : hasErrorUploads
                ? "rgba(220,38,38,0.03)"
                : "transparent",
          "&:hover": !disabled && !isUploading ? {
            borderColor: "primary.light",
            backgroundColor: "rgba(91,94,166,0.02)",
          } : {},
        }}
      >
        {!hasUploads ? (
          <>
            <PictureAsPdfIcon
              sx={{
                fontSize: 36,
                color: isDragOver ? "primary.main" : "rgba(0,0,0,0.2)",
                mb: 1,
                transition: "color 0.2s",
              }}
            />
            <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}>
              {translate("padmakara.transcript.dropzoneTitle") || "Drop PDF transcripts here"}
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 1.5 }}>
              {translate("padmakara.transcript.dropzoneSubtitle") || "or click to browse — accepts .pdf files"}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadFileIcon />}
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              disabled={disabled}
            >
              {translate("padmakara.transcript.browse") || "Browse PDFs"}
            </Button>
          </>
        ) : (
          <Box>
            {uploads.map((u) => (
              <UploadRow key={u.filename} upload={u} />
            ))}
            {!isUploading && (
              <Button
                size="small"
                variant="text"
                startIcon={<UploadFileIcon />}
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                disabled={disabled}
                sx={{ mt: 1.5 }}
              >
                {translate("padmakara.transcript.addMore") || "Add more PDFs"}
              </Button>
            )}
          </Box>
        )}
      </Box>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        style={{ display: "none" }}
        onChange={handleInputChange}
      />
    </Box>
  );
};

const UploadRow = ({ upload }: { upload: TranscriptUploadState }) => {
  const isUploading = upload.status === "uploading";
  const isDone = upload.status === "done";
  const isError = upload.status === "error";

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 1,
        py: 0.75,
        borderRadius: 1,
        mb: 0.5,
        backgroundColor: isDone
          ? "rgba(107,175,141,0.06)"
          : isError
            ? "rgba(220,38,38,0.05)"
            : "transparent",
      }}
    >
      <PictureAsPdfIcon
        sx={{
          fontSize: 16,
          color: isDone ? "success.main" : isError ? "error.main" : "primary.light",
          flexShrink: 0,
        }}
      />
      <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }} noWrap title={upload.filename}>
        {upload.filename}
      </Typography>

      {isUploading && (
        <Box sx={{ width: 80 }}>
          <LinearProgress
            variant="determinate"
            value={upload.progress * 100}
            sx={{ borderRadius: 1, height: 4 }}
          />
        </Box>
      )}

      {isDone && (
        <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main", flexShrink: 0 }} />
      )}

      {isError && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <ErrorOutlineIcon sx={{ fontSize: 16, color: "error.main", flexShrink: 0 }} />
          <Chip
            label={upload.error ?? "Error"}
            size="small"
            color="error"
            sx={{ height: 20, "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 } }}
          />
        </Box>
      )}

      {upload.status === "pending" && (
        <Chip
          label="Pending"
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(0,0,0,0.05)",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
          }}
        />
      )}
    </Box>
  );
};
