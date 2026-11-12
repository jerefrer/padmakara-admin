import { useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { FeatureStarButton } from "./FeatureStarButton";
import type { SectionVisibilityKey } from "../utils/mediaVisibility";

/** One "show in app" box offered in the publish dialog. */
export interface PublishSection {
  key: SectionVisibilityKey;
  label: string;
  /** Muted note after the label, e.g. "nothing yet". */
  detail?: string;
  /** Whether the box starts ticked. */
  checked: boolean;
}

interface EventStatusControlsProps {
  status: string;
  /** `sections` comes with a confirmed publish when `publishSections` was given:
   *  the "show in app" flags chosen in the dialog. */
  onStatusChange: (status: string, sections?: Partial<Record<SectionVisibilityKey, boolean>>) => void;
  /** The sections to offer when publishing, so their content goes live with the event. */
  publishSections?: PublishSection[];
  /** Present once the event exists: only then can it hold the highlight. */
  star?: {
    eventId: number | string;
    featured: boolean;
    title: string;
    titleOf: (record: { titleEn?: string | null; titlePt?: string | null }) => string;
    onFeatured: (event: { featuredAt?: string | null }) => void;
  };
}

/** Draft / Published toggle and the highlight star of an event. Either way,
 *  the switch asks first: it shows or hides the whole event in the app. When
 *  publishing, the dialog also offers the "show in app" box of each section. */
export function EventStatusControls({ status, onStatusChange, publishSections, star }: EventStatusControlsProps) {
  const translate = useTranslate();
  const [pending, setPending] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Partial<Record<SectionVisibilityKey, boolean>>>({});
  const publishing = pending === "published";
  const ask = (val: string) => {
    setChosen(Object.fromEntries((publishSections ?? []).map((sec) => [sec.key, sec.checked])));
    setPending(val);
  };
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      <ToggleButtonGroup
        value={status}
        exclusive
        onChange={(_, val) => { if (val) ask(val); }}
        size="small"
        sx={{ flexShrink: 0 }}
      >
        <ToggleButton
          value="draft"
          sx={{
            px: 2, fontWeight: 600, textTransform: "capitalize",
            "&.Mui-selected": { bgcolor: "warning.light", color: "warning.contrastText", "&:hover": { bgcolor: "warning.main" } },
          }}
        >
          {translate("padmakara.events.draft")}
        </ToggleButton>
        <ToggleButton
          value="published"
          sx={{
            px: 2, fontWeight: 600, textTransform: "capitalize",
            "&.Mui-selected": { bgcolor: "success.light", color: "success.contrastText", "&:hover": { bgcolor: "success.main" } },
          }}
        >
          {translate("padmakara.events.published")}
        </ToggleButton>
      </ToggleButtonGroup>
      {star && (
        <Box sx={{ ml: 1 }}>
          <FeatureStarButton
            eventId={star.eventId}
            status={status}
            featured={star.featured}
            title={star.title}
            titleOf={star.titleOf}
            size="medium"
            onFeatured={star.onFeatured}
          />
        </Box>
      )}
      <ConfirmChangeDialog
        open={pending !== null}
        title={translate(publishing ? "padmakara.events.confirmPublishTitle" : "padmakara.events.confirmUnpublishTitle")}
        message={translate(publishing ? "padmakara.events.confirmPublishMessage" : "padmakara.events.confirmUnpublishMessage")}
        confirmLabel={translate(publishing ? "padmakara.events.confirmPublish" : "padmakara.events.confirmUnpublish")}
        onConfirm={() => {
          if (pending) onStatusChange(pending, publishing && publishSections ? chosen : undefined);
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      >
        {publishing && publishSections && publishSections.length > 0 && (
          <Box sx={{ mt: 1.5, display: "flex", flexDirection: "column" }}>
            {publishSections.map((sec) => (
              <FormControlLabel
                key={sec.key}
                control={
                  <Checkbox
                    size="small"
                    checked={!!chosen[sec.key]}
                    onChange={(e) => setChosen((prev) => ({ ...prev, [sec.key]: e.target.checked }))}
                    slotProps={{ input: { "data-publish-section": sec.key } as object }}
                  />
                }
                label={
                  <>
                    {sec.label}
                    {sec.detail && (
                      <Box component="span" sx={{ color: "text.secondary", ml: 0.75 }}>({sec.detail})</Box>
                    )}
                  </>
                }
              />
            ))}
          </Box>
        )}
      </ConfirmChangeDialog>
    </Box>
  );
}
