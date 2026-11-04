import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslate } from "react-admin";
import type { InferredSession } from "../utils/trackParser";
import { EditTracksDialog, type BulkTrackPatch } from "./EditTracksDialog";
import type { SpeakerOption } from "./SpeakerPicker";

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
  /** When given, the bar offers "Edit selected…" (speaker / language / translation). */
  teachers?: SpeakerOption[];
  onBulkEdit?: (patch: BulkTrackPatch) => void | Promise<void>;
  /** When given, the bar offers "Delete selected…" behind a confirmation. */
  onBulkDelete?: () => void | Promise<void>;
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
  teachers = [],
  onBulkEdit,
  onBulkDelete,
}: MoveTracksBarProps) => {
  const translate = useTranslate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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
      data-testid="move-tracks-bar"
      sx={{
        // Sticky so the bar stays in view while the admin ticks tracks far
        // down the page (it used to sit above the first session only).
        position: "sticky",
        top: 8,
        zIndex: 10,
        backgroundColor: "background.paper",
        display: "flex",
        alignItems: "center",
        gap: 2,
        px: 2,
        py: 1,
        mb: 1.5,
      }}
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
      {onBulkEdit && (
        <Button size="small" variant="outlined" disabled={busy} onClick={() => setEditOpen(true)}>
          {translate("padmakara.tracks.bulk.editSelected")}
        </Button>
      )}
      {onBulkDelete && (
        <Button
          size="small"
          variant="outlined"
          color="error"
          disabled={busy}
          data-testid="delete-selected-tracks"
          onClick={() => setDeleteOpen(true)}
        >
          {translate("padmakara.tracks.bulk.deleteSelected")}
        </Button>
      )}
      <Box sx={{ flex: 1 }} />
      <Button size="small" onClick={onClear} disabled={busy}>
        {translate("padmakara.tracks.clearSelection")}
      </Button>

      {onBulkEdit && editOpen && (
        <EditTracksDialog
          open
          selectedCount={selectedCount}
          teachers={teachers}
          busy={busy}
          onClose={() => setEditOpen(false)}
          onApply={async (patch) => {
            await onBulkEdit(patch);
            setEditOpen(false);
          }}
        />
      )}

      {onBulkDelete && (
        <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle>
            {translate("padmakara.tracks.bulk.deleteTitle", { smart_count: selectedCount })}
          </DialogTitle>
          <DialogContent>
            <DialogContentText>{translate("padmakara.tracks.bulk.deleteWarning")}</DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDeleteOpen(false)}>{translate("ra.action.cancel")}</Button>
            <Button
              variant="contained"
              color="error"
              disabled={busy}
              data-testid="confirm-delete-tracks"
              onClick={async () => {
                setDeleteOpen(false);
                await onBulkDelete();
              }}
            >
              {translate("padmakara.tracks.bulk.deleteConfirm", { smart_count: selectedCount })}
            </Button>
          </DialogActions>
        </Dialog>
      )}

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
