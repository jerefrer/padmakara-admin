import { useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import Tooltip from "@mui/material/Tooltip";
import type { SectionVisibilityKey } from "../utils/mediaVisibility";
import { ConfirmChangeDialog } from "./ConfirmChangeDialog";

interface SectionVisibilityCheckboxProps {
  /** Which flag of the event this box drives. */
  flag: SectionVisibilityKey;
  label: string;
  /** Ticked = visible in the app. */
  visible: boolean;
  onChange: (flag: SectionVisibilityKey, value: boolean) => void;
}

/** A compact tick box for a section header: ticked means the section shows in
 *  the app. Ticking asks first, since the content goes live at once; unticking does not. */
export function SectionVisibilityCheckbox({ flag, label, visible, onChange }: SectionVisibilityCheckboxProps) {
  const translate = useTranslate();
  const [confirming, setConfirming] = useState(false);
  const tooltip = translate(visible ? "padmakara.events.mediaVisible" : "padmakara.events.mediaHidden");
  return (
    <>
    <Tooltip title={tooltip}>
      <Box
        component="label"
        sx={{ display: "inline-flex", alignItems: "center", cursor: "pointer", fontSize: 14, fontWeight: 500 }}
      >
        <Checkbox
          size="small"
          checked={visible}
          onChange={(event) => {
            if (event.target.checked) setConfirming(true);
            else onChange(flag, false);
          }}
          slotProps={{ input: { "aria-label": `${label}: ${tooltip}`, "data-visibility": flag } as object }}
          sx={{ p: 0.5 }}
        />
        {label}
      </Box>
    </Tooltip>
    <ConfirmChangeDialog
      open={confirming}
      title={translate("padmakara.events.confirmShowTitle")}
      message={translate("padmakara.events.confirmShowMessage")}
      confirmLabel={translate("padmakara.events.showInApp")}
      onConfirm={() => {
        setConfirming(false);
        onChange(flag, true);
      }}
      onCancel={() => setConfirming(false)}
    />
    </>
  );
}
