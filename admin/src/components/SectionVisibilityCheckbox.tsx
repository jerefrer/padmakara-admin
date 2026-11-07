import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import Tooltip from "@mui/material/Tooltip";
import type { SectionVisibilityKey } from "../utils/mediaVisibility";

interface SectionVisibilityCheckboxProps {
  /** Which flag of the event this box drives. */
  flag: SectionVisibilityKey;
  label: string;
  /** Ticked = visible in the app. */
  visible: boolean;
  onChange: (flag: SectionVisibilityKey, value: boolean) => void;
}

/** A compact tick box for a section header: ticked means the section shows in the app. */
export function SectionVisibilityCheckbox({ flag, label, visible, onChange }: SectionVisibilityCheckboxProps) {
  const translate = useTranslate();
  const tooltip = translate(visible ? "padmakara.events.mediaVisible" : "padmakara.events.mediaHidden");
  return (
    <Tooltip title={tooltip}>
      <Box
        component="label"
        sx={{ display: "inline-flex", alignItems: "center", cursor: "pointer", fontSize: 14, fontWeight: 500 }}
      >
        <Checkbox
          size="small"
          checked={visible}
          onChange={(event) => onChange(flag, event.target.checked)}
          slotProps={{ input: { "aria-label": `${label}: ${tooltip}`, "data-visibility": flag } as object }}
          sx={{ p: 0.5 }}
        />
        {label}
      </Box>
    </Tooltip>
  );
}
