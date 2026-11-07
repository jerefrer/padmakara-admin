import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { FeatureStarButton } from "./FeatureStarButton";

interface EventStatusControlsProps {
  status: string;
  onStatusChange: (status: string) => void;
  /** Present once the event exists: only then can it hold the highlight. */
  star?: {
    eventId: number | string;
    featured: boolean;
    title: string;
    titleOf: (record: { titleEn?: string | null; titlePt?: string | null }) => string;
    onFeatured: (event: { featuredAt?: string | null }) => void;
  };
}

/** Draft / Published toggle and the highlight star of an event. */
export function EventStatusControls({ status, onStatusChange, star }: EventStatusControlsProps) {
  const translate = useTranslate();
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      <ToggleButtonGroup
        value={status}
        exclusive
        onChange={(_, val) => { if (val) onStatusChange(val); }}
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
    </Box>
  );
}
