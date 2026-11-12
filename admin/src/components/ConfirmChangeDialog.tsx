import { useTranslate } from "react-admin";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";

interface ConfirmChangeDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes/no check before a change that shows or hides content in the app right away. */
export function ConfirmChangeDialog({ open, title, message, confirmLabel, onConfirm, onCancel }: ConfirmChangeDialogProps) {
  const translate = useTranslate();
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>{title}</DialogTitle>
      <DialogContent>
        <Typography>{message}</Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onCancel} data-testid="confirm-change-cancel">
          {translate("padmakara.events.cancel")}
        </Button>
        <Button variant="contained" disableElevation onClick={onConfirm} data-testid="confirm-change-ok">
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
