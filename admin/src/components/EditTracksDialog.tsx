import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslate } from "react-admin";
import { languageLabel } from "../utils/trackParser";
import { SpeakerChipPicker, type SpeakerOption } from "./SpeakerPicker";
import { DEFAULT_LANG_CHIP, LANG_CHIP_COLORS, LANGUAGE_CODES, toggleChipSx } from "./inlineEditKit";

/** Only the fields the admin changed are present. `speaker: null` clears it. */
export interface BulkTrackPatch {
  speaker?: string | null;
  languages?: string[];
  isTranslation?: boolean;
}

type Tri = "keep" | "yes" | "no";

interface EditTracksDialogProps {
  open: boolean;
  selectedCount: number;
  teachers: SpeakerOption[];
  busy: boolean;
  onClose: () => void;
  onApply: (patch: BulkTrackPatch) => void | Promise<void>;
}

/** Set speaker / language / translation on every ticked track at once. Each
 *  field starts at "leave unchanged" and is only sent once the admin touches it. */
export const EditTracksDialog = ({
  open,
  selectedCount,
  teachers,
  busy,
  onClose,
  onApply,
}: EditTracksDialogProps) => {
  const translate = useTranslate();
  // undefined = leave unchanged, null = clear the speaker.
  const [speaker, setSpeaker] = useState<string | null | undefined>(undefined);
  const [languages, setLanguages] = useState<string[]>([]);
  const [translation, setTranslation] = useState<Tri>("keep");

  const patch: BulkTrackPatch = {};
  if (speaker !== undefined) patch.speaker = speaker;
  if (languages.length > 0) patch.languages = languages;
  if (translation !== "keep") patch.isTranslation = translation === "yes";
  const changed = Object.keys(patch).length > 0;

  const speakerLabel =
    speaker === undefined
      ? translate("padmakara.tracks.bulk.unchanged")
      : speaker === null
        ? translate("padmakara.tracks.noSpeaker")
        : speaker;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {translate("padmakara.tracks.bulk.title", { smart_count: selectedCount })}
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2.5, pt: "8px !important" }}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {translate("padmakara.tracks.speaker")}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
            <SpeakerChipPicker
              value={speaker ?? null}
              teachers={teachers}
              onChange={(abbr) => setSpeaker(abbr)}
            />
            <Typography variant="body2" data-testid="bulk-speaker-state">
              {speakerLabel}
            </Typography>
            {speaker !== undefined && (
              <Button size="small" onClick={() => setSpeaker(undefined)}>
                {translate("padmakara.tracks.bulk.reset")}
              </Button>
            )}
          </Box>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary">
            {translate("padmakara.tracks.bulk.languages")}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mt: 0.5 }}>
            {LANGUAGE_CODES.map((lang) => (
              <Chip
                key={lang}
                size="small"
                label={languageLabel(lang)}
                onClick={() =>
                  setLanguages((prev) =>
                    prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang],
                  )
                }
                sx={toggleChipSx(languages.includes(lang), LANG_CHIP_COLORS[lang] || DEFAULT_LANG_CHIP)}
              />
            ))}
            {languages.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {translate("padmakara.tracks.bulk.unchanged")}
              </Typography>
            )}
          </Box>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" display="block">
            {translate("padmakara.session.translation")}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={translation}
            onChange={(_, v: Tri | null) => setTranslation(v ?? "keep")}
            sx={{ mt: 0.5 }}
          >
            <ToggleButton value="keep">{translate("padmakara.tracks.bulk.unchanged")}</ToggleButton>
            <ToggleButton value="yes">{translate("padmakara.tracks.bulk.yes")}</ToggleButton>
            <ToggleButton value="no">{translate("padmakara.tracks.bulk.no")}</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{translate("ra.action.cancel")}</Button>
        <Button
          variant="contained"
          disabled={!changed || busy}
          onClick={() => void onApply(patch)}
        >
          {translate("padmakara.tracks.bulk.apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
