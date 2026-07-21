/**
 * Event-level "Documents" section — images, PDFs, and Office files that
 * accompany an event but aren't a track (audio/video) or a transcript.
 *
 * Rendered beside the Transcript section in both the create and edit forms.
 * Uploading only needs `eventCode` (the S3 key prefix), so the drop-zone is
 * available before the event has a real database id. Persisting an
 * `event_files` row, however, needs a real `eventId` — so:
 *  - Edit mode (`eventId` set): upload → create the row immediately → show
 *    it in the interactive, reorderable list below.
 *  - Create mode (`eventId` undefined): upload only; `onPendingUpload` hands
 *    the uploaded file's metadata back to the parent, which creates the
 *    `event_files` rows once the event itself is saved and a real id exists
 *    (mirroring how sessions/tracks are deferred to save-time today).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDataProvider, useNotify, useTranslate } from "react-admin";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DescriptionIcon from "@mui/icons-material/Description";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import FolderIcon from "@mui/icons-material/Folder";
import ImageIcon from "@mui/icons-material/Image";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import TableChartIcon from "@mui/icons-material/TableChart";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { authFetch } from "../utils/authFetch";
import { formatFileSize } from "../utils/trackParser";
import { uploadFile } from "../utils/uploadManager";
import { clickToEditSx, quietInputSx } from "./inlineEditKit";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
const ACCEPTED_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|webp|bmp|svg)$/i;

function deriveFileMeta(filename: string): { fileType: "image" | "document"; extension: string } {
  const extension = (filename.split(".").pop() || "").toLowerCase();
  return { fileType: IMAGE_EXTS.has(extension) ? "image" : "document", extension };
}

function isAcceptedDocumentFile(file: File): boolean {
  return ACCEPTED_EXT_RE.test(file.name);
}

function fileIconFor(extension: string, fileType: string) {
  const ext = extension.toLowerCase();
  if (fileType === "image" || IMAGE_EXTS.has(ext)) return <ImageIcon sx={{ fontSize: 18 }} />;
  if (ext === "pdf") return <PictureAsPdfIcon sx={{ fontSize: 18 }} />;
  if (ext === "xls" || ext === "xlsx") return <TableChartIcon sx={{ fontSize: 18 }} />;
  if (ext === "ppt" || ext === "pptx") return <SlideshowIcon sx={{ fontSize: 18 }} />;
  return <DescriptionIcon sx={{ fontSize: 18 }} />;
}

interface DocumentUploadState {
  filename: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number; // 0-1
  error?: string;
}

/** An `event_files` row as returned by the admin API. */
export interface EventFileRow {
  id: number;
  eventId: number;
  originalFilename: string;
  s3Key: string;
  fileType: string;
  extension: string;
  fileSizeBytes: number | null;
  title: string | null;
  sensitive: boolean;
  sortOrder: number;
}

/** Metadata for a document uploaded before the event has a real id — handed
 *  back to the parent so it can create the `event_files` row once one exists. */
export interface PendingDocument {
  originalFilename: string;
  s3Key: string;
  fileType: string;
  extension: string;
  fileSizeBytes: number;
}

interface DocumentsSectionProps {
  /** Needed to build the S3 key prefix — available as soon as the admin has
   *  filled in enough of the form to auto-generate an event code. */
  eventCode: string;
  /** The event's real database id. Undefined in the create flow until the
   *  event itself has been saved — gates the interactive persisted list. */
  eventId?: number;
  disabled?: boolean;
  /** Create-flow only: called after each successful upload while `eventId`
   *  is still undefined, so the parent can persist the row once it has one. */
  onPendingUpload?: (doc: PendingDocument) => void;
}

export const DocumentsSection = ({
  eventCode,
  eventId,
  disabled = false,
  onPendingUpload,
}: DocumentsSectionProps) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const translate = useTranslate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const [files, setFiles] = useState<EventFileRow[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploads, setUploads] = useState<DocumentUploadState[]>([]);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!eventId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    dataProvider
      .getList<EventFileRow>("event-files", {
        pagination: { page: 1, perPage: 200 },
        sort: { field: "sortOrder", order: "ASC" },
        filter: { eventId },
      })
      .then(({ data }) => {
        if (!cancelled) setFiles(data);
      })
      .catch((err: any) => {
        if (!cancelled) {
          notify(`${translate("padmakara.documents.loadFailed") || "Failed to load documents"}: ${err?.message || String(err)}`, {
            type: "error",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const handleFilesDropped = useCallback(
    async (dropped: File[]) => {
      const accepted = dropped.filter(isAcceptedDocumentFile);
      if (accepted.length === 0) return;
      if (!eventCode) {
        notify(translate("padmakara.documents.saveFirst") || "Save the event first, then upload documents", {
          type: "warning",
        });
        return;
      }

      const initial: DocumentUploadState[] = accepted.map((f) => ({
        filename: f.name,
        status: "pending",
        progress: 0,
      }));
      setUploads((prev) => [...prev, ...initial]);

      // Local running counter — avoids every file in the same drop batch
      // reading the same stale `files.length` before state catches up.
      let nextSortOrder = files.length;

      for (const file of accepted) {
        setUploads((prev) =>
          prev.map((u) => (u.filename === file.name && u.status === "pending" ? { ...u, status: "uploading" } : u)),
        );
        try {
          const { fileType, extension } = deriveFileMeta(file.name);
          const { s3Key } = await uploadFile(eventCode, file, fileType, (progress) => {
            setUploads((prev) => prev.map((u) => (u.filename === file.name ? { ...u, progress } : u)));
          });
          setUploads((prev) =>
            prev.map((u) => (u.filename === file.name ? { ...u, status: "done", progress: 1 } : u)),
          );

          if (eventId) {
            const { data: created } = await dataProvider.create<EventFileRow>("event-files", {
              data: {
                eventId,
                originalFilename: file.name,
                s3Key,
                fileType,
                extension,
                fileSizeBytes: file.size,
                title: null,
                sensitive: false,
                sortOrder: nextSortOrder++,
              },
            });
            setFiles((prev) => [...prev, created]);
          } else {
            onPendingUpload?.({
              originalFilename: file.name,
              s3Key,
              fileType,
              extension,
              fileSizeBytes: file.size,
            });
          }
          notify(`${file.name} — ${translate("padmakara.documents.uploadSuccess") || "uploaded"}`, { type: "success" });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          setUploads((prev) =>
            prev.map((u) => (u.filename === file.name ? { ...u, status: "error", error: msg } : u)),
          );
          notify(`${translate("padmakara.documents.uploadFailed") || "Upload failed"}: ${msg}`, { type: "error" });
        }
      }
    },
    [eventCode, eventId, files.length, dataProvider, notify, translate, onPendingUpload],
  );

  const triggerPicker = () => fileInputRef.current?.click();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length) void handleFilesDropped(picked);
  };

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragOver(true);
    },
    [disabled],
  );
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
      void handleFilesDropped(Array.from(e.dataTransfer.files));
    },
    [disabled, handleFilesDropped],
  );

  // event_files only has PATCH endpoints (no PUT) — the generic react-admin
  // dataProvider.update() sends PUT, so row edits go through authFetch
  // directly, mirroring EventVideosSection's patchVideo() for the same reason.
  const patchFile = async (fileId: number, patch: Record<string, unknown>): Promise<EventFileRow> => {
    const res = await authFetch(`/api/admin/event-files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const withBusy = async (fileId: number, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(fileId));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  };

  const handleTitleSave = (fileId: number, title: string) =>
    withBusy(fileId, async () => {
      try {
        const trimmed = title.trim() || null;
        await patchFile(fileId, { title: trimmed });
        setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, title: trimmed } : f)));
      } catch (err: any) {
        notify(`${translate("padmakara.documents.updateFailed") || "Failed to update document"}: ${err?.message || String(err)}`, {
          type: "error",
        });
      }
    });

  const handleSensitiveToggle = (fileId: number, sensitive: boolean) =>
    withBusy(fileId, async () => {
      try {
        await patchFile(fileId, { sensitive });
        setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, sensitive } : f)));
      } catch (err: any) {
        notify(`${translate("padmakara.documents.updateFailed") || "Failed to update document"}: ${err?.message || String(err)}`, {
          type: "error",
        });
      }
    });

  const handleReorder = (fileId: number, direction: -1 | 1) =>
    withBusy(fileId, async () => {
      const sorted = [...files].sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = sorted.findIndex((f) => f.id === fileId);
      const otherIdx = idx + direction;
      if (idx < 0 || otherIdx < 0 || otherIdx >= sorted.length) return;
      const a = sorted[idx]!;
      const b = sorted[otherIdx]!;
      try {
        await Promise.all([
          patchFile(a.id, { sortOrder: b.sortOrder }),
          patchFile(b.id, { sortOrder: a.sortOrder }),
        ]);
        setFiles((prev) =>
          prev.map((f) => {
            if (f.id === a.id) return { ...f, sortOrder: b.sortOrder };
            if (f.id === b.id) return { ...f, sortOrder: a.sortOrder };
            return f;
          }),
        );
      } catch (err: any) {
        notify(`${translate("padmakara.documents.reorderFailed") || "Failed to reorder documents"}: ${err?.message || String(err)}`, {
          type: "error",
        });
      }
    });

  const handleDelete = (fileId: number) =>
    withBusy(fileId, async () => {
      if (
        !window.confirm(
          translate("padmakara.documents.deleteConfirm") || "Delete this document? This cannot be undone.",
        )
      ) {
        return;
      }
      try {
        await dataProvider.delete("event-files", { id: fileId });
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
        notify(translate("padmakara.documents.deleted") || "Document removed", { type: "success" });
      } catch (err: any) {
        notify(`${translate("padmakara.documents.deleteFailed") || "Failed to delete document"}: ${err?.message || String(err)}`, {
          type: "error",
        });
      }
    });

  const sorted = [...files].sort((a, b) => a.sortOrder - b.sortOrder);
  const isUploading = uploads.some((u) => u.status === "uploading");
  const hasDoneUploads = uploads.some((u) => u.status === "done");
  const hasErrorUploads = uploads.some((u) => u.status === "error");

  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <Box sx={{ color: "primary.main" }}>
          <FolderIcon />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.1rem" }}>
          {translate("padmakara.documents.title") || "Documents"}
        </Typography>
        {sorted.length > 0 && (
          <Chip
            label={
              translate("padmakara.documents.count", { count: sorted.length, smart_count: sorted.length }) ||
              `${sorted.length} document${sorted.length !== 1 ? "s" : ""}`
            }
            size="small"
            variant="outlined"
            sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
          />
        )}
      </Box>

      <Paper sx={{ p: 3 }}>
        {eventId && loadingFiles && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

        {eventId && !loadingFiles && sorted.length === 0 && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
            <Box sx={{ color: "text.disabled", display: "flex" }}>
              <FolderIcon sx={{ fontSize: 18 }} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.85rem", fontStyle: "italic" }}>
              {translate("padmakara.documents.none") || "No documents yet"}
            </Typography>
          </Box>
        )}

        {eventId && sorted.length > 0 && (
          <Box sx={{ mb: 2, border: "1px solid rgba(0,0,0,0.06)", borderRadius: 1, overflow: "hidden" }}>
            {sorted.map((file, idx) => (
              <DocumentRow
                key={file.id}
                file={file}
                isFirst={idx === 0}
                isLast={idx === sorted.length - 1}
                busy={busyIds.has(file.id)}
                onTitleSave={handleTitleSave}
                onSensitiveToggle={handleSensitiveToggle}
                onReorder={handleReorder}
                onDelete={handleDelete}
              />
            ))}
          </Box>
        )}

        <Box
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !disabled && !isUploading && triggerPicker()}
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
            p: uploads.length > 0 ? 2 : 3,
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
            "&:hover":
              !disabled && !isUploading
                ? { borderColor: "primary.light", backgroundColor: "rgba(91,94,166,0.02)" }
                : {},
          }}
        >
          {uploads.length === 0 ? (
            <>
              <UploadFileIcon
                sx={{
                  fontSize: 32,
                  color: isDragOver ? "primary.main" : "rgba(0,0,0,0.2)",
                  mb: 1,
                  transition: "color 0.2s",
                }}
              />
              <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}>
                {translate("padmakara.documents.dropzoneTitle") || "Drop documents here"}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 1.5 }}>
                {translate("padmakara.documents.dropzoneSubtitle") ||
                  "or click to browse — images, PDF, Word, Excel, PowerPoint"}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                startIcon={<UploadFileIcon />}
                onClick={(e) => {
                  e.stopPropagation();
                  triggerPicker();
                }}
                disabled={disabled}
              >
                {translate("padmakara.documents.browse") || "Browse files"}
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
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerPicker();
                  }}
                  disabled={disabled}
                  sx={{ mt: 1.5 }}
                >
                  {translate("padmakara.documents.addMore") || "Add more files"}
                </Button>
              )}
            </Box>
          )}
        </Box>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/*"
          multiple
          style={{ display: "none" }}
          onChange={handleInputChange}
        />
      </Paper>
    </Box>
  );
};

/* ───────── One persisted document row ───────── */

interface DocumentRowProps {
  file: EventFileRow;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onTitleSave: (fileId: number, title: string) => void;
  onSensitiveToggle: (fileId: number, sensitive: boolean) => void;
  onReorder: (fileId: number, direction: -1 | 1) => void;
  onDelete: (fileId: number) => void;
}

const DocumentRow = ({
  file,
  isFirst,
  isLast,
  busy,
  onTitleSave,
  onSensitiveToggle,
  onReorder,
  onDelete,
}: DocumentRowProps) => {
  const translate = useTranslate();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(file.title ?? "");
  const doneRef = useRef(false);

  const openEditor = () => {
    setTitleDraft(file.title ?? "");
    doneRef.current = false;
    setEditingTitle(true);
  };

  const saveTitle = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (titleDraft !== (file.title ?? "")) onTitleSave(file.id, titleDraft);
    setEditingTitle(false);
  };

  const cancelEdit = () => {
    doneRef.current = true;
    setEditingTitle(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const displayTitle = file.title || file.originalFilename;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1.25,
        borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.04)",
        "&:hover": { backgroundColor: editingTitle ? "transparent" : "rgba(91,94,166,0.02)" },
      }}
    >
      <Box sx={{ color: "primary.light", display: "flex", flexShrink: 0 }}>
        {fileIconFor(file.extension, file.fileType)}
      </Box>

      {editingTitle ? (
        <InputBase
          autoFocus
          fullWidth
          value={titleDraft}
          placeholder={file.originalFilename}
          onChange={(e) => setTitleDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={saveTitle}
          sx={{ ...quietInputSx, flex: 1 }}
        />
      ) : (
        <Typography
          variant="body2"
          noWrap
          title={translate("padmakara.documents.clickToEdit") || "Click to edit title"}
          onClick={openEditor}
          sx={{ flex: 1, minWidth: 0, fontWeight: 500, display: "inline-block", ...clickToEditSx }}
        >
          {displayTitle}
        </Typography>
      )}

      <Chip
        label={file.extension.toUpperCase()}
        size="small"
        sx={{
          height: 20,
          flexShrink: 0,
          backgroundColor: "rgba(0,0,0,0.04)",
          color: "text.secondary",
          "& .MuiChip-label": { fontSize: "0.6rem", px: 0.5, fontWeight: 600, fontFamily: "monospace" },
        }}
      />

      {file.fileSizeBytes != null && (
        <Typography variant="caption" sx={{ color: "text.secondary", fontSize: "0.7rem", minWidth: 44, textAlign: "right", flexShrink: 0 }}>
          {formatFileSize(file.fileSizeBytes)}
        </Typography>
      )}

      <Tooltip title={translate("padmakara.documents.sensitiveToggle") || "Mark sensitive"}>
        <span>
          <IconButton
            size="small"
            onClick={() => onSensitiveToggle(file.id, !file.sensitive)}
            disabled={busy}
            sx={{ color: file.sensitive ? "warning.main" : "text.disabled" }}
          >
            <VisibilityOffIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </span>
      </Tooltip>

      <IconButton
        size="small"
        onClick={() => onReorder(file.id, -1)}
        disabled={isFirst || busy}
        title={translate("padmakara.documents.moveUp") || "Move up"}
      >
        <ArrowUpwardIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <IconButton
        size="small"
        onClick={() => onReorder(file.id, 1)}
        disabled={isLast || busy}
        title={translate("padmakara.documents.moveDown") || "Move down"}
      >
        <ArrowDownwardIcon sx={{ fontSize: 16 }} />
      </IconButton>

      <Tooltip title={translate("padmakara.documents.delete") || "Delete"}>
        <span>
          <IconButton size="small" onClick={() => onDelete(file.id)} disabled={busy}>
            {busy ? (
              <CircularProgress size={14} />
            ) : (
              <DeleteOutlineIcon sx={{ fontSize: 17, color: "text.secondary" }} />
            )}
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
};

/* ───────── One in-flight upload row (pre-persistence progress feedback) ───────── */

const UploadRow = ({ upload }: { upload: DocumentUploadState }) => {
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
        backgroundColor: isDone ? "rgba(107,175,141,0.06)" : isError ? "rgba(220,38,38,0.05)" : "transparent",
      }}
    >
      <UploadFileIcon
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
          <LinearProgress variant="determinate" value={upload.progress * 100} sx={{ borderRadius: 1, height: 4 }} />
        </Box>
      )}

      {isDone && <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main", flexShrink: 0 }} />}

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
    </Box>
  );
};
