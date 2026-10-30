import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import { useTranslate } from "react-admin";

interface EventEditActionsProps {
  saving: boolean;
  deleting: boolean;
  canSave: boolean;
  onDelete: () => void;
  onCancel: () => void;
  /** Save and stay on the page. */
  onSave: () => void;
  /** Save, then leave for the events list. */
  onSaveAndClose: () => void;
}

/** Bottom action row of the event edit page: Delete on the left; Cancel,
 *  "Save & close" (secondary) and "Save" (primary, stays on the page) on the right. */
export const EventEditActions = ({
  saving,
  deleting,
  canSave,
  onDelete,
  onCancel,
  onSave,
  onSaveAndClose,
}: EventEditActionsProps) => {
  const translate = useTranslate();
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
      <Button
        variant="outlined"
        color="error"
        startIcon={<DeleteIcon />}
        onClick={onDelete}
        disabled={saving || deleting}
      >
        {translate("padmakara.events.delete")}
      </Button>
      <Box sx={{ display: "flex", gap: 2 }}>
        <Button variant="outlined" onClick={onCancel} disabled={saving}>
          {translate("padmakara.events.cancel")}
        </Button>
        <Button variant="outlined" onClick={onSaveAndClose} disabled={saving || !canSave}>
          {translate("padmakara.events.saveAndClose")}
        </Button>
        <Button
          variant="contained"
          size="large"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={saving || !canSave}
          sx={{ px: 4, py: 1.2, fontSize: "0.95rem" }}
        >
          {saving ? translate("padmakara.events.saving") : translate("padmakara.events.saveChanges")}
        </Button>
      </Box>
    </Box>
  );
};
