import { useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import Tooltip from "@mui/material/Tooltip";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
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
      const value = typeof out.v === "string" ? out.v : "";
      if (!value.trim()) {
        // The endpoint returned no usable translation for this field (the model
        // occasionally drops or renames the key). Returning "" here would let
        // every caller's `if (out != null)` guard overwrite — and thereby WIPE —
        // the target field. Return null so the field is left intact and tell the
        // user to retry instead.
        notify(translate("padmakara.events.translateEmpty"), { type: "warning" });
        return null;
      }
      return value;
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

/**
 * Amber "AI · review ✓" chip shown while a field holds an unreviewed AI
 * translation. Clicking it marks the field reviewed. Replaces the old 9px
 * amber dot, which read as decoration rather than a control.
 */
export const AiReviewChip = ({ onClick }: { onClick: () => void }) => {
  const translate = useTranslate();
  const tooltip = `${translate("padmakara.events.aiUnreviewed")} — ${translate("padmakara.events.markReviewed")}`;
  return (
    <Tooltip title={tooltip}>
      <Chip
        label={translate("padmakara.events.aiChipLabel")}
        size="small"
        onClick={onClick}
        sx={{
          height: 20,
          fontWeight: 600,
          backgroundColor: "rgba(237,108,2,0.12)",
          color: "#c05000",
          "& .MuiChip-label": { px: 0.75, fontSize: "0.65rem" },
          "&:hover": { backgroundColor: "rgba(237,108,2,0.22)" },
        }}
      />
    </Tooltip>
  );
};

/**
 * Directional translate control: a small "PT → EN" / "EN → PT" chip with an
 * AI sparkles icon. It sits on the SOURCE field and fills the sibling-language
 * field — the direction is readable without hovering, the tooltip adds the
 * detail (which field gets filled).
 */
export const TranslateDirChip = ({
  direction,
  onClick,
  disabled,
  pending,
  tooltip,
}: {
  direction: TranslateDirection;
  onClick: () => void;
  /** True when this field (the translation source) is empty. */
  disabled?: boolean;
  pending?: boolean;
  tooltip: string;
}) => (
  <Tooltip title={tooltip}>
    <span>
      <Chip
        icon={
          pending ? (
            <CircularProgress size={11} sx={{ ml: 0.5 }} />
          ) : (
            <AutoAwesomeIcon sx={{ fontSize: "13px !important" }} />
          )
        }
        label={direction === "pt-to-en" ? "PT → EN" : "EN → PT"}
        size="small"
        clickable
        disabled={disabled || pending}
        onClick={onClick}
        sx={{
          height: 20,
          fontWeight: 600,
          letterSpacing: "0.02em",
          backgroundColor: "rgba(91,94,166,0.09)",
          color: "primary.main",
          "& .MuiChip-label": { px: 0.75, fontSize: "0.65rem" },
          "& .MuiChip-icon": { color: "primary.main" },
          "&:hover": { backgroundColor: "rgba(91,94,166,0.18)" },
        }}
      />
    </span>
  </Tooltip>
);

export interface TranslatableFieldProps {
  value: string;
  /** Manual edit — caller sets value + marks the field reviewed. */
  onChange: (value: string) => void;
  reviewed: boolean;
  onMarkReviewed: () => void;
  /** Translates THIS field's text and fills the sibling-language field
   *  (setting its value + reviewed=false) on success. */
  onTranslate: () => void;
  /** Disables the translate button while any translation is in flight. */
  translatePending: boolean;
  /** False when this field (the translation source) is empty. */
  canTranslate: boolean;
  /** Direction this field's text is translated in, e.g. "en-to-pt" on the
   *  English field. */
  direction: TranslateDirection;
  label: string;
  /** Tooltip on the translate chip — the localized detail of what it does. */
  translateTooltip: string;
  placeholder?: string;
  multiline?: boolean;
  minRows?: number;
  required?: boolean;
}

/**
 * One quiet text field with two corner chips: a directional translate chip
 * (AI sparkles icon) that translates THIS field's text into its
 * sibling-language field, and — only while the value is an unreviewed AI
 * translation — an amber "AI · review ✓" chip that marks it reviewed on
 * click.
 */
export function TranslatableField({
  value,
  onChange,
  reviewed,
  onMarkReviewed,
  onTranslate,
  translatePending,
  canTranslate,
  direction,
  label,
  translateTooltip,
  placeholder,
  multiline,
  minRows,
  required,
}: TranslatableFieldProps) {
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
                {!reviewed && <AiReviewChip onClick={onMarkReviewed} />}
                <TranslateDirChip
                  direction={direction}
                  disabled={!canTranslate}
                  pending={translatePending}
                  tooltip={translateTooltip}
                  onClick={onTranslate}
                />
              </Box>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
