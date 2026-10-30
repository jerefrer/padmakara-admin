import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslate } from "react-admin";
import type { InferredSession } from "../utils/trackParser";

export type MoveTarget =
  | { kind: "existing"; sessionId: number }
  | { kind: "new"; date: string; timePeriod: string };

const NEW_SESSION = "__new__";
const PERIODS = ["morning", "afternoon", "evening"] as const;

interface MoveTracksBarProps {
  sessions: InferredSession[];
  selectedCount: number;
  busy: boolean;
  /** ISO date pre-filled in the "new session" dialog. */
  defaultDate: string;
  onMove: (target: MoveTarget) => void | Promise<void>;
  onClear: () => void;
}

/** Shown while tracks are ticked on the event edit page: move them to an
 *  existing session or to a new one. */
export const MoveTracksBar = ({
  sessions,
  selectedCount,
  busy,
  defaultDate,
  onMove,
  onClear,
}: MoveTracksBarProps) => {
  const translate = useTranslate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [date, setDate] = useState(defaultDate);
  const [timePeriod, setTimePeriod] = useState<string>("morning");

  if (selectedCount === 0) return null;

  const handleSelect = (value: string) => {
    if (value === NEW_SESSION) {
      setDate(defaultDate);
      setDialogOpen(true);
      return;
    }
    void onMove({ kind: "existing", sessionId: Number(value) });
  };

  return (
    <Paper
      variant="outlined"
      sx={{ display: "flex", alignItems: "center", gap: 2, px: 2, py: 1, mb: 1.5 }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {translate("padmakara.tracks.selectedCount", { smart_count: selectedCount })}
      </Typography>
      <TextField
        select
        size="small"
        disabled={busy}
        value=""
        label={translate("padmakara.tracks.moveTo")}
        onChange={(e) => handleSelect(e.target.value)}
        sx={{ minWidth: 280 }}
      >
        {sessions
          .filter((s) => s.id !== undefined)
          .map((s) => (
            <MenuItem key={s.id} value={String(s.id)}>
              {translate("padmakara.tracks.sessionOption", {
                number: s.sessionNumber,
                title: s.titleEn,
              })}
            </MenuItem>
          ))}
        <MenuItem value={NEW_SESSION}>{translate("padmakara.tracks.newSession")}</MenuItem>
      </TextField>
      <Box sx={{ flex: 1 }} />
      <Button size="small" onClick={onClear} disabled={busy}>
        {translate("padmakara.tracks.clearSelection")}
      </Button>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{translate("padmakara.tracks.moveTitle")}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}>
          <TextField
            type="date"
            size="small"
            label={translate("padmakara.tracks.moveDate")}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            select
            size="small"
            label={translate("padmakara.tracks.movePeriod")}
            value={timePeriod}
            onChange={(e) => setTimePeriod(e.target.value)}
          >
            {PERIODS.map((p) => (
              <MenuItem key={p} value={p}>
                {translate(`padmakara.session.${p}`)}
              </MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{translate("ra.action.cancel")}</Button>
          <Button
            variant="contained"
            disabled={!date || busy}
            onClick={async () => {
              setDialogOpen(false);
              await onMove({ kind: "new", date, timePeriod });
            }}
          >
            {translate("padmakara.tracks.moveConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};
