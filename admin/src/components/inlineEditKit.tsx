/**
 * Shared visual vocabulary for the click-to-edit title editors used by the
 * edit flow (SessionPreview) and the create/import flow (SessionTrackTable):
 * language chip colors, the small EN/PT input tags, the quiet inline input
 * styling and the dashed-underline click-to-edit affordance.
 */

import Box from "@mui/material/Box";

export const LANG_CHIP_COLORS: Record<string, { bg: string; text: string }> = {
  en: { bg: "#eff6ff", text: "#1d4ed8" },
  pt: { bg: "#f0fdf4", text: "#15803d" },
  fr: { bg: "#faf5ff", text: "#7e22ce" },
  tib: { bg: "#fffbeb", text: "#b45309" },
};
export const DEFAULT_LANG_CHIP = { bg: "rgba(91,94,166,0.06)", text: "text.primary" };

export const LANGUAGE_CODES = ["en", "pt", "fr", "tib"];

/** Small "EN" / "PT" tag that labels a quiet inline input with the same
 *  color vocabulary as the language chips in view mode. */
export const LangTag = ({ code }: { code: string }) => {
  const lc = LANG_CHIP_COLORS[code] || DEFAULT_LANG_CHIP;
  return (
    <Box
      sx={{
        height: 20,
        px: 0.9,
        borderRadius: 10,
        backgroundColor: lc.bg,
        color: lc.text,
        fontSize: "0.65rem",
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      {code.toUpperCase()}
    </Box>
  );
};

/** Quiet inline input used by the click-to-edit title editors — sized to sit
 *  in a list row without breaking its rhythm. */
export const quietInputSx = {
  flex: 1,
  fontSize: "0.85rem",
  px: 1,
  py: 0.25,
  borderRadius: 1.5,
  backgroundColor: "rgba(91,94,166,0.06)",
  border: "1px solid transparent",
  "&.Mui-focused": {
    backgroundColor: "background.paper",
    borderColor: "primary.main",
    boxShadow: "0 0 0 2px rgba(91,94,166,0.15)",
  },
  "& input": { p: 0 },
} as const;

/** Dashed-underline hover affordance shared by the click-to-edit titles. */
export const clickToEditSx = {
  cursor: "text",
  borderBottom: "1px dashed transparent",
  "&:hover": { borderBottomColor: "rgba(91,94,166,0.5)" },
} as const;

/** Chip sx for a toggleable metadata chip (language, Practice, Translation):
 *  active keeps the chip's own colors + an inset ring, inactive greys out. */
export const toggleChipSx = (
  active: boolean,
  activeColors: { bg: string; text: string },
) => ({
  height: 20,
  fontWeight: 600,
  "& .MuiChip-label": { px: 0.6, fontSize: "0.65rem" },
  ...(active
    ? {
        backgroundColor: activeColors.bg,
        color: activeColors.text,
        boxShadow: "inset 0 0 0 1.5px currentColor",
        "& .MuiChip-icon": { color: activeColors.text },
        "&:hover": { backgroundColor: activeColors.bg },
      }
    : {
        backgroundColor: "rgba(0,0,0,0.04)",
        color: "text.disabled",
        "& .MuiChip-icon": { color: "text.disabled" },
      }),
});
