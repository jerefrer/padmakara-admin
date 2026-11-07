import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import { FeatureStarButton } from "./FeatureStarButton";

export type MediaVisibilityKey = "audioPublished" | "videoPublished";

interface MediaVisibilityProps {
  audioPublished: boolean;
  videoPublished: boolean;
  onChange: (key: MediaVisibilityKey, value: boolean) => void;
}

interface EventStatusControlsProps {
  status: string;
  onStatusChange: (status: string) => void;
  /** Audio / Video visibility toggles, shown only while the event is published. */
  media?: MediaVisibilityProps;
  /** Present once the event exists: only then can it hold the highlight. */
  star?: {
    eventId: number | string;
    featured: boolean;
    title: string;
    titleOf: (record: { titleEn?: string | null; titlePt?: string | null }) => string;
    onFeatured: (event: { featuredAt?: string | null }) => void;
  };
}

/** Draft / Published toggle, the audio / video visibility toggles and the highlight star of an event. */
export function EventStatusControls({ status, onStatusChange, media, star }: EventStatusControlsProps) {
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
      {media && status === "published" && (
        <Box sx={{ display: "flex", gap: 0.5, ml: 1 }}>
          {(
            [
              ["audio", "audioPublished", "padmakara.events.mediaAudio"],
              ["video", "videoPublished", "padmakara.events.mediaVideo"],
            ] as const
          ).map(([kind, key, labelKey]) => {
            const visible = media[key];
            return (
              <Tooltip
                key={kind}
                title={translate(visible ? "padmakara.events.mediaVisible" : "padmakara.events.mediaHidden")}
              >
                <ToggleButton
                  value={kind}
                  data-media={kind}
                  selected={visible}
                  size="small"
                  onChange={() => media.onChange(key, !visible)}
                  sx={{
                    px: 1.5, fontWeight: 600, textTransform: "none",
                    "&.Mui-selected": { bgcolor: "success.light", color: "success.contrastText", "&:hover": { bgcolor: "success.main" } },
                  }}
                >
                  {translate(labelKey)}
                </ToggleButton>
              </Tooltip>
            );
          })}
        </Box>
      )}
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
