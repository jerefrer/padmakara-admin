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
 *  the app. Either way it asks first, since the change reaches the app at once. */
export function SectionVisibilityCheckbox({ flag, label, visible, onChange }: SectionVisibilityCheckboxProps) {
  const translate = useTranslate();
  /** The value waiting for confirmation, or null when no dialog is open. */
  const [pending, setPending] = useState<boolean | null>(null);
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
          onChange={(event) => setPending(event.target.checked)}
          slotProps={{ input: { "aria-label": `${label}: ${tooltip}`, "data-visibility": flag } as object }}
          sx={{ p: 0.5 }}
        />
        {label}
      </Box>
    </Tooltip>
    <ConfirmChangeDialog
      open={pending !== null}
      title={translate(pending === false ? "padmakara.events.confirmHideTitle" : "padmakara.events.confirmShowTitle")}
      message={translate(pending === false ? "padmakara.events.confirmHideMessage" : "padmakara.events.confirmShowMessage")}
      confirmLabel={translate(pending === false ? "padmakara.events.confirmHide" : "padmakara.events.showInApp")}
      onConfirm={() => {
        if (pending !== null) onChange(flag, pending);
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    />
    </>
  );
}
