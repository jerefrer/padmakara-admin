import { useRef, useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { FeatureStarButton } from "./FeatureStarButton";
import type { SectionVisibilityKey } from "../utils/mediaVisibility";

/** One "show in app" box offered in the publish dialog. */
/** Who would get the "now available" email, from GET /events/:id/recipients. */
export interface PublishRecipients {
  count: number;
  /** ISO date of an earlier send, or null. */
  notifiedAt: string | null;
}

/** What a confirmed publish asks for besides the status. */
export interface PublishOptions {
  /** Email the people who have access that the event is now available. */
  notify: boolean;
}

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
  onStatusChange: (
    status: string,
    sections?: Partial<Record<SectionVisibilityKey, boolean>>,
    /** Only given when publishing with the "email them" box ticked. */
    options?: PublishOptions,
  ) => void;
  /** Present once the event exists: asked when the publish dialog opens, to offer the
   *  "email the people who have access" box. Absent in the create wizard (no email there). */
  loadRecipients?: () => Promise<PublishRecipients>;
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

/** Draft / Forthcoming / Published toggle and the highlight star of an event. Any
 *  switch asks first: it shows or hides the event, or its content, in the app. When
 *  publishing, the dialog also offers the "show in app" box of each section and, once
 *  the event has people with access, a box to email them that it is now available. */
export function EventStatusControls({ status, onStatusChange, publishSections, loadRecipients, star }: EventStatusControlsProps) {
  const translate = useTranslate();
  const [pending, setPending] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Partial<Record<SectionVisibilityKey, boolean>>>({});
  const [recipients, setRecipients] = useState<PublishRecipients | null>(null);
  const [notifyChecked, setNotifyChecked] = useState(true);
  // Answers of an earlier dialog must not land in a later one
  const askCount = useRef(0);
  const publishing = pending === "published";
  const forthcoming = pending === "forthcoming";
  const ask = (val: string) => {
    setChosen(Object.fromEntries((publishSections ?? []).map((sec) => [sec.key, sec.checked])));
    setRecipients(null);
    setNotifyChecked(true);
    setPending(val);
    const mine = ++askCount.current;
    if (val === "published" && loadRecipients) {
      loadRecipients()
        .then((r) => { if (askCount.current === mine) setRecipients(r); })
        .catch(() => { /* no box when the count cannot be fetched: publishing still works */ });
    }
  };
  const canNotify = !!recipients && recipients.count > 0 && !recipients.notifiedAt;
  const confirmKey = publishing ? "Publish" : forthcoming ? "Forthcoming" : "Unpublish";
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
          value="forthcoming"
          sx={{
            px: 2, fontWeight: 600, textTransform: "capitalize",
            "&.Mui-selected": { bgcolor: "info.light", color: "info.contrastText", "&:hover": { bgcolor: "info.main" } },
          }}
        >
          {translate("padmakara.events.forthcoming")}
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
        title={translate(`padmakara.events.confirm${confirmKey}Title`)}
        message={translate(`padmakara.events.confirm${confirmKey}Message`)}
        confirmLabel={translate(`padmakara.events.confirm${confirmKey}`)}
        onConfirm={() => {
          if (pending) {
            const sections = publishing && publishSections ? chosen : undefined;
            if (publishing && canNotify && notifyChecked) onStatusChange(pending, sections, { notify: true });
            else onStatusChange(pending, sections);
          }
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
        {publishing && canNotify && recipients && (
          <Box sx={{ mt: 1 }}>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={notifyChecked}
                  onChange={(e) => setNotifyChecked(e.target.checked)}
                  slotProps={{ input: { "data-testid": "notify-on-publish" } as object }}
                />
              }
              label={translate("padmakara.events.notifyOnPublish", { smart_count: recipients.count })}
            />
          </Box>
        )}
        {publishing && recipients?.notifiedAt && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }} data-testid="already-notified">
            {translate("padmakara.events.alreadyNotified", {
              date: new Date(recipients.notifiedAt).toLocaleDateString(),
            })}
          </Typography>
        )}
      </ConfirmChangeDialog>
    </Box>
  );
}
