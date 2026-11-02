/**
 * Right panel of the slide editor: timing and subtitle of the selected slide,
 * and its slide-level actions. A logo clip has none of that, so it gets a
 * fixed-length note and "Remove".
 */

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import IconButton from "@mui/material/IconButton";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { useTranslate } from "react-admin";
import { BUILTIN_CLIPS, isClipSlide, type Slide } from "@slides/types.ts";
import { slideEditorTokens } from "../slideEditorTokens";
import { subtitleText, withSubtitleText, type SubtitleLanguage } from "../utils/slideDocument";

const SectionTitle = ({ children }: { children: string }) => (
  <Box
    component="h3"
    sx={{ m: 0, mb: 1, fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em", color: slideEditorTokens.muted }}
  >
    {children}
  </Box>
);

interface SlideInspectorProps {
  slide: Slide | null;
  /** Language of the subtitle field; undefined hides it (the outro has none). */
  subtitleLang?: SubtitleLanguage;
  onTiming: (patch: Partial<Pick<Slide, "durationMs" | "fadeMs">>) => void;
  onSubtitle: (patch: ReturnType<typeof withSubtitleText>) => void;
  onMove: (direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}

export const SlideInspector = ({
  slide,
  subtitleLang,
  onTiming,
  onSubtitle,
  onMove,
  canMoveUp,
  canMoveDown,
  onDuplicate,
  onDelete,
}: SlideInspectorProps) => {
  const translate = useTranslate();

  const frame = {
    width: 290,
    flexShrink: 0,
    overflowY: "auto" as const,
    backgroundColor: "background.paper",
    borderLeft: `1px solid ${slideEditorTokens.border}`,
    p: 2,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2.5,
  };

  if (!slide) return <Box component="aside" sx={frame} aria-label={translate("padmakara.slides.inspector", { _: "Slide settings" })} />;

  if (isClipSlide(slide) && slide.clip) {
    const seconds = BUILTIN_CLIPS[slide.clip].durationMs / 1000;
    return (
      <Box component="aside" sx={frame} aria-label={translate("padmakara.slides.inspector", { _: "Slide settings" })}>
        <Box sx={{ fontSize: "0.85rem", color: slideEditorTokens.ink }}>
          {`${translate("padmakara.slides.logoClipTitle", { _: "Padmakara logo animation" })} · ${seconds} s · ${translate("padmakara.slides.fixed", { _: "fixed" })}`}
        </Box>
        <Button
          color="inherit"
          startIcon={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
          onClick={onDelete}
          sx={{ alignSelf: "flex-start", color: slideEditorTokens.muted }}
        >
          {translate("padmakara.slides.remove", { _: "Remove" })}
        </Button>
      </Box>
    );
  }

  return (
    <Box component="aside" sx={frame} aria-label={translate("padmakara.slides.inspector", { _: "Slide settings" })}>
      <Box component="section">
        <SectionTitle>{translate("padmakara.slides.timing", { _: "Timing" }).toUpperCase()}</SectionTitle>
        <Box sx={{ display: "flex", gap: 1.5 }}>
          <TextField
            size="small"
            type="number"
            label={translate("padmakara.slides.onScreenSeconds", { _: "On screen (seconds)" })}
            value={slide.durationMs / 1000}
            onChange={(e) => onTiming({ durationMs: Math.max(0, Number(e.target.value) || 0) * 1000 })}
            slotProps={{ htmlInput: { min: 0.5, step: 0.5 }, inputLabel: { shrink: true } }}
          />
          <TextField
            size="small"
            type="number"
            label={translate("padmakara.slides.fadeSeconds", { _: "Fade in and out (seconds)" })}
            value={slide.fadeMs / 1000}
            onChange={(e) => onTiming({ fadeMs: Math.round(Math.max(0, Number(e.target.value) || 0) * 1000) })}
            slotProps={{ htmlInput: { min: 0, step: 0.1 }, inputLabel: { shrink: true } }}
          />
        </Box>
      </Box>

      {subtitleLang && (
        <Box component="section">
          <SectionTitle>
            {(subtitleLang === "pt"
              ? translate("padmakara.slides.subtitleHeadingPt", { _: "Portuguese subtitle" })
              : translate("padmakara.slides.subtitleHeadingEn", { _: "English subtitle" })
            ).toUpperCase()}
          </SectionTitle>
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            value={subtitleText(slide, subtitleLang)}
            onChange={(e) => onSubtitle(withSubtitleText(slide, subtitleLang, e.target.value))}
            helperText={translate("padmakara.slides.subtitleHelper", { _: "Shown over this slide when subtitles are on." })}
            slotProps={{
              htmlInput: {
                "aria-label":
                  subtitleLang === "pt"
                    ? translate("padmakara.slides.subtitleHeadingPt", { _: "Portuguese subtitle" })
                    : translate("padmakara.slides.subtitleHeadingEn", { _: "English subtitle" }),
              },
            }}
          />
        </Box>
      )}

      <Box sx={{ flex: 1 }} />

      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <IconButton
            size="small"
            disabled={!canMoveUp}
            onClick={() => onMove(-1)}
            aria-label={translate("padmakara.slides.moveEarlier", { _: "Move slide earlier" })}
          >
            <ArrowUpwardIcon sx={{ fontSize: 16 }} />
          </IconButton>
          <IconButton
            size="small"
            disabled={!canMoveDown}
            onClick={() => onMove(1)}
            aria-label={translate("padmakara.slides.moveLater", { _: "Move slide later" })}
          >
            <ArrowDownwardIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
        <Button
          color="inherit"
          startIcon={<ContentCopyIcon sx={{ fontSize: 16 }} />}
          onClick={onDuplicate}
          sx={{ justifyContent: "flex-start", color: slideEditorTokens.ink }}
        >
          {translate("padmakara.slides.duplicateSlide", { _: "Duplicate slide" })}
        </Button>
        <Button
          color="inherit"
          startIcon={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
          onClick={onDelete}
          sx={{ justifyContent: "flex-start", color: "primary.main" }}
        >
          {translate("padmakara.slides.deleteSlide", { _: "Delete slide" })}
        </Button>
      </Box>
    </Box>
  );
};
