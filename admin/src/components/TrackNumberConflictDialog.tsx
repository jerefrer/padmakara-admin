/**
 * Offered when a moved track lands on a number its language already uses in
 * the target session (a session can't hold two tracks with the same number
 * and language). Instead of an error, it says which track is in the way and
 * lets the admin give one of the two another number, then the move goes on.
 */

import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import { useTranslate } from "react-admin";
import { languageLabel } from "../utils/trackParser";

/** The `details` of the API's 409 TRACK_NUMBER_TAKEN. */
export interface TrackNumberConflict {
  sessionNumber: number | null;
  trackNumber: number;
  language: string;
  blocking: { id: number; title: string } | null;
  suggestedForBlocking: number;
  suggestedForMoved: number;
}

export type ConflictChoice = { renumber: "blocking" | "moved"; number: number };

interface Props {
  /** Null keeps the dialog closed. */
  conflict: TrackNumberConflict | null;
  movedTitle: string;
  onResolve: (choice: ConflictChoice) => void;
  onCancel: () => void;
}

export function TrackNumberConflictDialog({ conflict, movedTitle, onResolve, onCancel }: Props) {
  const translate = useTranslate();
  const [choice, setChoice] = useState<"blocking" | "moved">("blocking");
  const [numbers, setNumbers] = useState({ blocking: "", moved: "" });

  // Each new conflict starts from the suggestions.
  useEffect(() => {
    if (!conflict) return;
    setChoice(conflict.blocking ? "blocking" : "moved");
    setNumbers({ blocking: String(conflict.suggestedForBlocking), moved: String(conflict.suggestedForMoved) });
  }, [conflict]);

  if (!conflict) return null;

  const chosen = Number.parseInt(numbers[choice], 10);
  const valid = Number.isInteger(chosen) && chosen > 0 && chosen !== conflict.trackNumber;
  const blockingTitle = conflict.blocking?.title ?? "";

  const option = (which: "blocking" | "moved", title: string) => (
    <Box data-testid={`conflict-option-${which}`} sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1 }}>
      <FormControlLabel
        value={which}
        control={<Radio size="small" />}
        label={translate("padmakara.tracks.conflictRenumber", { title })}
        sx={{ mr: 0, flex: 1, minWidth: 0 }}
      />
      <TextField
        data-testid={`conflict-number-${which}`}
        type="number"
        size="small"
        value={numbers[which]}
        onChange={(e) => {
          setNumbers((p) => ({ ...p, [which]: e.target.value }));
          setChoice(which);
        }}
        slotProps={{ htmlInput: { min: 1, "aria-label": translate("padmakara.tracks.conflictNumber") } }}
        sx={{ width: 96, flexShrink: 0 }}
      />
    </Box>
  );

  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{translate("padmakara.tracks.conflictTitle")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {translate("padmakara.tracks.conflictText", {
            session: conflict.sessionNumber ?? "?",
            language: translate(`padmakara.tracks.lang_${conflict.language}`, { _: languageLabel(conflict.language) }),
            number: conflict.trackNumber,
            title: blockingTitle,
          })}
        </Typography>
        <RadioGroup value={choice} onChange={(e) => setChoice(e.target.value as "blocking" | "moved")}>
          {conflict.blocking && option("blocking", blockingTitle)}
          {option("moved", movedTitle)}
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Button data-testid="conflict-cancel" onClick={onCancel}>
          {translate("ra.action.cancel")}
        </Button>
        <Button
          data-testid="conflict-confirm"
          variant="contained"
          disabled={!valid}
          onClick={() => onResolve({ renumber: choice, number: chosen })}
        >
          {translate("padmakara.tracks.conflictConfirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The conflict carried by a react-admin HttpError from PUT /tracks/:id, or null for any other error. */
export function trackNumberConflictOf(err: unknown): TrackNumberConflict | null {
  const e = err as { status?: number; body?: { code?: string; details?: TrackNumberConflict } } | null;
  if (e?.status !== 409 || e.body?.code !== "TRACK_NUMBER_TAKEN" || !e.body.details) return null;
  return e.body.details;
}
