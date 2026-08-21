/**
 * One editable line within a slide — type-specific editor (text/image/
 * spacer) plus the reorder/delete controls shared by every line type.
 * Extracted out of SlideEditor.tsx to keep that file to slide/tab-level
 * orchestration.
 */

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ImageIcon from "@mui/icons-material/Image";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { isBuiltinKey } from "@slides/defaults.ts";
import type { Line, LineSize } from "@slides/types.ts";
import { uploadFile } from "../utils/uploadManager";
import { RichTextLineField } from "./RichTextLineField";

const SIZES: LineSize[] = ["sm", "md", "lg", "xl"];

interface SlideLineRowProps {
  line: Line;
  isFirst: boolean;
  isLast: boolean;
  eventCode?: string;
  onChange: (line: Line) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Registers the freshly-uploaded file's object URL so the live preview
   *  can show it immediately without a round-trip to resolve the s3Key. */
  onImageUploaded: (s3Key: string, file: File) => void;
  resolveImageUrl: (s3Key: string) => string;
}

export const SlideLineRow = ({
  line,
  isFirst,
  isLast,
  eventCode,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onImageUploaded,
  resolveImageUrl,
}: SlideLineRowProps) => {
  const translate = useTranslate();

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, py: 0.5 }}>
      <Box sx={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <IconButton size="small" disabled={isFirst} onClick={onMoveUp} sx={{ p: 0.3 }}>
          <ArrowUpwardIcon sx={{ fontSize: 13 }} />
        </IconButton>
        <IconButton size="small" disabled={isLast} onClick={onMoveDown} sx={{ p: 0.3 }}>
          <ArrowDownwardIcon sx={{ fontSize: 13 }} />
        </IconButton>
      </Box>

      {line.type === "text" && (
        <>
          <RichTextLineField
            spans={line.spans}
            onChange={(spans) => onChange({ ...line, spans })}
            placeholder={translate("padmakara.slides.textPlaceholder") || "Line text…"}
          />
          <Select
            size="small"
            value={line.size}
            onChange={(e) => onChange({ ...line, size: e.target.value as LineSize })}
            sx={{ fontSize: "0.75rem", height: 30, minWidth: 64, flexShrink: 0 }}
          >
            {SIZES.map((s) => (
              <MenuItem key={s} value={s} sx={{ fontSize: "0.8rem" }}>
                {translate(`padmakara.slides.size.${s}`) || s.toUpperCase()}
              </MenuItem>
            ))}
          </Select>
          <FormControlLabel
            sx={{ flexShrink: 0, mr: 0, "& .MuiFormControlLabel-label": { fontSize: "0.72rem" } }}
            control={
              <Checkbox
                size="small"
                checked={!!line.dim}
                onChange={(e) => onChange({ ...line, dim: e.target.checked })}
              />
            }
            label={translate("padmakara.slides.dim") || "Dim"}
          />
        </>
      )}

      {line.type === "image" && (
        <ImageLineEditor
          s3Key={line.s3Key}
          alt={line.alt}
          eventCode={eventCode}
          resolveImageUrl={resolveImageUrl}
          onChangeKey={(s3Key) => onChange({ ...line, s3Key })}
          onChangeAlt={(alt) => onChange({ ...line, alt })}
          onImageUploaded={onImageUploaded}
        />
      )}

      {line.type === "spacer" && (
        <Box sx={{ flex: 1, display: "flex", alignItems: "center", py: 0.5 }}>
          <Typography variant="caption" sx={{ color: "text.disabled", fontStyle: "italic" }}>
            {translate("padmakara.slides.spacerLabel") || "Spacer"}
          </Typography>
        </Box>
      )}

      <Tooltip title={translate("padmakara.slides.deleteLine") || "Delete line"}>
        <IconButton size="small" onClick={onDelete} sx={{ flexShrink: 0 }}>
          <DeleteOutlineIcon sx={{ fontSize: 15, color: "text.secondary" }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

/* ───────── Image line: upload picker + builtin-key affordance ───────── */

interface ImageLineEditorProps {
  s3Key: string;
  alt?: string;
  eventCode?: string;
  resolveImageUrl: (s3Key: string) => string;
  onChangeKey: (s3Key: string) => void;
  onChangeAlt: (alt: string) => void;
  onImageUploaded: (s3Key: string, file: File) => void;
}

const ImageLineEditor = ({
  s3Key,
  alt,
  eventCode,
  resolveImageUrl,
  onChangeKey,
  onChangeAlt,
  onImageUploaded,
}: ImageLineEditorProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const builtin = s3Key ? isBuiltinKey(s3Key) : false;
  const thumbUrl = s3Key ? resolveImageUrl(s3Key) : null;

  const handlePick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!eventCode) {
      notify(
        translate("padmakara.slides.imageUploadNeedsEventCode") ||
          "Image upload isn't wired up yet for this screen — see the follow-up notes.",
        { type: "warning" },
      );
      return;
    }
    setUploading(true);
    try {
      const { s3Key: uploadedKey } = await uploadFile(eventCode, file, "image");
      onChangeKey(uploadedKey);
      onImageUploaded(uploadedKey, file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.slides.imageUploadFailed") || "Image upload failed"}: ${msg}`, {
        type: "error",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box sx={{ flex: 1, display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
      <Box
        sx={{
          width: 44,
          height: 26,
          flexShrink: 0,
          borderRadius: 0.75,
          backgroundColor: "#000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {thumbUrl ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img src={thumbUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : (
          <ImageIcon sx={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }} />
        )}
      </Box>

      <Typography variant="caption" sx={{ flex: 1, minWidth: 0, color: "text.secondary" }} noWrap>
        {builtin
          ? translate("padmakara.slides.imageBuiltin") || "Padmakara logo (built in)"
          : s3Key || translate("padmakara.slides.imageNone") || "No image selected"}
      </Typography>

      <TextField
        size="small"
        variant="standard"
        placeholder={translate("padmakara.slides.altText") || "Alt text"}
        value={alt ?? ""}
        onChange={(e) => onChangeAlt(e.target.value)}
        sx={{ width: 110, flexShrink: 0, "& input": { fontSize: "0.72rem" } }}
      />

      <Tooltip
        title={
          s3Key
            ? translate("padmakara.slides.imageReplace") || "Replace image"
            : translate("padmakara.slides.imageUpload") || "Upload image"
        }
      >
        <span>
          <IconButton size="small" onClick={handlePick} disabled={uploading}>
            {uploading ? <CircularProgress size={14} /> : <UploadFileIcon sx={{ fontSize: 15 }} />}
          </IconButton>
        </span>
      </Tooltip>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => void handleFile(e)} />
    </Box>
  );
};
