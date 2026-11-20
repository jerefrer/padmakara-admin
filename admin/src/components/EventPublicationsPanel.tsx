/**
 * "Related texts" of an event: the publications an admin ticks to show on it.
 * The publications of the event's user groups come as a tick list (nothing is
 * ticked by itself); a text outside those groups is added from a picker over
 * all other publications. The ticks are the event's `publicationIds`: the page
 * owns them and Save writes them with the rest of the event.
 */

import { useEffect, useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authFetch } from "../utils/authFetch";
import { CheckboxMultiSelect } from "./CheckboxMultiSelect";

interface PublicationSummary {
  id: number;
  title: string;
  language: string;
  version: string | null;
  status: string;
}

interface EventPublications {
  selectedIds: number[];
  viaGroups: PublicationSummary[];
  others: PublicationSummary[];
}

interface Props {
  eventId: number;
  /** Ticked publication ids; null until the page has received them through `onLoaded`. */
  selectedIds: number[] | null;
  /** The ids ticked on the event as stored, once loaded. */
  onLoaded: (ids: number[]) => void;
  onChange: (ids: number[]) => void;
}

const optionLabel = (p: PublicationSummary): string => `${p.title} (${p.language.toUpperCase()})`;

export const EventPublicationsPanel = ({ eventId, selectedIds, onLoaded, onChange }: Props) => {
  const translate = useTranslate();
  const [data, setData] = useState<EventPublications | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/admin/events/${eventId}/publications`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EventPublications;
        if (!cancelled) {
          setData(json);
          onLoaded(json.selectedIds);
        }
      } catch (err) {
        // Without the list there is nothing to tick: a failed load hides the panel.
        console.error("Event publications load failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLoaded is a report-back, not an input
  }, [eventId]);

  if (!data || selectedIds === null) return null;
  if (data.viaGroups.length === 0 && data.others.length === 0) return null;

  const ticked = new Set(selectedIds);
  const toggle = (id: number, on: boolean) =>
    onChange(on ? [...selectedIds, id] : selectedIds.filter((x) => x !== id));

  const statusNote = (p: PublicationSummary): string =>
    p.status === "published"
      ? ""
      : ` · ${translate(`padmakara.eventPublications.status.${p.status}`, { _: p.status })}`;
  const detail = (p: PublicationSummary): string =>
    `${p.language.toUpperCase()}${
      p.version ? ` · ${translate("padmakara.eventPublications.version") || "Version"} ${p.version}` : ""
    }${statusNote(p)}`;

  // Pickable outside the groups: every other publication. A ticked one stays in
  // the picker as a chip, so it can be unticked there.
  const pickedOthers = data.others.filter((p) => ticked.has(p.id));

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600, color: "text.secondary" }}>
        {translate("padmakara.eventPublications.title") || "Texts of this event's groups"}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1.5, color: "text.secondary" }}>
        {translate("padmakara.eventPublications.hint") ||
          "Tick the texts to show on this event in the app. A publication set for this event's user groups is only offered here, never shown on its own. To add a text to the list, upload it in Publications."}
      </Typography>

      {data.viaGroups.length > 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          {data.viaGroups.map((p) => (
            <FormControlLabel
              key={p.id}
              control={
                <Checkbox
                  size="small"
                  checked={ticked.has(p.id)}
                  onChange={(_, on) => toggle(p.id, on)}
                />
              }
              label={
                <>
                  {p.title}
                  <Typography component="span" variant="caption" sx={{ color: "text.secondary", ml: 1 }}>
                    {detail(p)}
                  </Typography>
                </>
              }
            />
          ))}
        </Box>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary", fontStyle: "italic" }}>
          {translate("padmakara.eventPublications.noneForGroups") ||
            "No publication is set for this event's user groups."}
        </Typography>
      )}

      {data.others.length > 0 && (
        <Box sx={{ mt: 2.5 }}>
          <CheckboxMultiSelect<PublicationSummary>
            options={data.others}
            getOptionLabel={optionLabel}
            renderOptionContent={(p) => (
              <>
                {p.title}
                <Typography component="span" variant="caption" sx={{ color: "text.secondary", ml: 1 }}>
                  {detail(p)}
                </Typography>
              </>
            )}
            value={pickedOthers}
            onChange={(_, picked) =>
              onChange([
                ...selectedIds.filter((id) => !data.others.some((p) => p.id === id)),
                ...picked.map((p) => p.id),
              ])
            }
            isOptionEqualToValue={(o, v) => o.id === v.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label={translate("padmakara.eventPublications.addLabel") || "Other publications"}
                placeholder={translate("padmakara.eventPublications.addPlaceholder") || "Search a publication…"}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            )}
          />
        </Box>
      )}
    </Paper>
  );
};
