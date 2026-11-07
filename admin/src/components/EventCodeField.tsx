import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import { useTranslate } from "react-admin";
import { AiReviewChip } from "./TranslatableField";

/**
 * Returns the form with `code` as an automatically generated event code,
 * flagged as not yet approved. A code a person typed (or took from the library
 * record) is reviewed and non-empty, so it is returned untouched and later
 * changes to the date, teachers or place never overwrite it.
 */
export function withAutoEventCode<T extends { eventCode: string; eventCodeReviewed: boolean }>(
  form: T,
  code: string,
): T {
  if (form.eventCodeReviewed && form.eventCode !== "") return form;
  return { ...form, eventCode: code, eventCodeReviewed: false };
}

export interface EventCodeFieldProps {
  value: string;
  reviewed: boolean;
  /** Manual edit: the caller sets the value and marks the code reviewed. */
  onChange: (value: string) => void;
  onMarkReviewed: () => void;
  readOnly?: boolean;
}

/**
 * The event code input. While the code was filled in automatically it carries
 * the same amber approve chip as AI-filled titles, on the label line.
 */
export function EventCodeField({ value, reviewed, onChange, onMarkReviewed, readOnly }: EventCodeFieldProps) {
  const translate = useTranslate();
  return (
    <Box sx={{ position: "relative" }}>
      {!reviewed && (
        <Box
          sx={{
            position: "absolute",
            top: 0,
            right: 10,
            transform: "translateY(-50%)",
            zIndex: 1,
            px: 0.5,
            backgroundColor: "background.paper",
          }}
        >
          <AiReviewChip
            onClick={onMarkReviewed}
            labelKey="padmakara.events.eventCodeChipLabel"
            reasonKey="padmakara.events.eventCodeUnreviewed"
          />
        </Box>
      )}
      <TextField
        label={translate("padmakara.events.eventCode")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        fullWidth
        helperText={translate("padmakara.events.eventCodeHelper")}
        slotProps={{
          inputLabel: { shrink: true },
          htmlInput: { readOnly },
        }}
        sx={{ "& input": { fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.02em" } }}
      />
    </Box>
  );
}
