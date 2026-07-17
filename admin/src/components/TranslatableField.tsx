import { useState } from "react";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Tooltip from "@mui/material/Tooltip";
import CircularProgress from "@mui/material/CircularProgress";
import TranslateIcon from "@mui/icons-material/Translate";
import { useNotify, useTranslate } from "react-admin";
import { translateFields, type TranslateDirection } from "../utils/translateFields";

/**
 * Shared translate-in-flight state + error handling for a form that may have
 * several `TranslatableField`s. Only one translation runs at a time — callers
 * pass the same `translating` flag to every field so all translate buttons
 * disable together while any one of them is in flight.
 */
export function useFieldTranslate() {
  const notify = useNotify();
  const translate = useTranslate();
  const [translating, setTranslating] = useState(false);

  const run = async (source: string, direction: TranslateDirection): Promise<string | null> => {
    const text = source.trim();
    if (!text) return null;
    setTranslating(true);
    try {
      const out = await translateFields(direction, { v: text });
      return out.v ?? "";
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
      return null;
    } finally {
      setTranslating(false);
    }
  };

  return { translate: run, translating };
}

export interface TranslatableFieldProps {
  value: string;
  /** Manual edit — caller sets value + marks the field reviewed. */
  onChange: (value: string) => void;
  reviewed: boolean;
  onMarkReviewed: () => void;
  /** Runs the translation and sets value + reviewed=false on success. */
  onTranslate: () => void;
  /** Disables the translate button while any translation is in flight. */
  translatePending: boolean;
  /** False when the source (sibling-language) field is empty. */
  canTranslate: boolean;
  label: string;
  /** Tooltip on the translate icon — the localized direction, e.g. "→ Portuguese". */
  translateTooltip: string;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  required?: boolean;
}

/**
 * One quiet text field that replaces the old "→ Portuguese" link + "AI ·
 * unreviewed" chip + "Mark reviewed" button row. A single small translate
 * icon-button fills this field from its sibling language; an amber dot
 * (shown only while unreviewed) doubles as the "mark reviewed" affordance.
 */
export function TranslatableField({
  value,
  onChange,
  reviewed,
  onMarkReviewed,
  onTranslate,
  translatePending,
  canTranslate,
  label,
  translateTooltip,
  placeholder,
  multiline,
  minRows,
  required,
}: TranslatableFieldProps) {
  const translate = useTranslate();
  const reviewedTooltip =
    `${translate("padmakara.events.aiUnreviewed")} — ${translate("padmakara.events.markReviewed")}`;

  return (
    <TextField
      fullWidth
      label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      multiline={multiline}
      minRows={minRows}
      required={required}
      sx={{
        // Multiline fields keep the adornment pinned to the top-right corner
        // rather than centered against the full textarea height, so it reads
        // as a corner control instead of floating mid-paragraph.
        "& .MuiOutlinedInput-root": { alignItems: multiline ? "flex-start" : "center" },
      }}
      slotProps={{
        inputLabel: { shrink: true },
        input: {
          endAdornment: (
            <InputAdornment position="end" sx={multiline ? { mt: 1.25 } : undefined}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                {!reviewed && (
                  <Tooltip title={reviewedTooltip}>
                    <Box
                      component="button"
                      type="button"
                      onClick={onMarkReviewed}
                      aria-label={reviewedTooltip}
                      sx={{
                        width: 9,
                        height: 9,
                        p: 0,
                        border: 0,
                        borderRadius: "50%",
                        bgcolor: "warning.main",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>
                )}
                <Tooltip title={translateTooltip}>
                  <span>
                    <IconButton
                      size="small"
                      edge="end"
                      disabled={!canTranslate || translatePending}
                      onClick={onTranslate}
                    >
                      {translatePending ? <CircularProgress size={16} /> : <TranslateIcon fontSize="small" />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
