/**
 * Floating toolbar above the slide: formatting for the selected line.
 * Presentational only; the editor wires it to the document.
 */

import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import OpacityIcon from "@mui/icons-material/Opacity";
import TextFieldsIcon from "@mui/icons-material/TextFields";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useState } from "react";
import { useTranslate } from "react-admin";
import type { Line, LineSize } from "@slides/types.ts";
import { slideEditorTokens } from "../slideEditorTokens";

const SIZES: { size: LineSize; short: string; key: string; fallback: string }[] = [
  { size: "sm", short: "S", key: "padmakara.slides.size.sm", fallback: "Small" },
  { size: "md", short: "M", key: "padmakara.slides.size.md", fallback: "Medium" },
  { size: "lg", short: "L", key: "padmakara.slides.size.lg", fallback: "Large" },
  { size: "xl", short: "XL", key: "padmakara.slides.size.xl", fallback: "Extra large" },
];

interface SlideLineToolbarProps {
  /** The selected line; null hides the toolbar's controls (disabled state). */
  line: Line | null;
  marks: { bold: boolean; italic: boolean };
  onSize: (size: LineSize) => void;
  onMark: (mark: "bold" | "italic") => void;
  onToggleSmallCaps: () => void;
  onToggleDim: () => void;
  onDelete: () => void;
}

export const SlideLineToolbar = ({
  line,
  marks,
  onSize,
  onMark,
  onToggleSmallCaps,
  onToggleDim,
  onDelete,
}: SlideLineToolbarProps) => {
  const translate = useTranslate();
  const [sizeAnchor, setSizeAnchor] = useState<HTMLElement | null>(null);
  const text = line?.type === "text" ? line : null;
  const currentSize = SIZES.find((s) => s.size === text?.size) ?? SIZES[1]!;

  // Pressing a formatting button must not take the caret out of the slide.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const iconSx = { fontSize: 18 };
  const buttonSx = (pressed: boolean) => ({
    borderRadius: 1,
    color: pressed ? "primary.main" : slideEditorTokens.ink,
    backgroundColor: pressed ? "rgba(155,27,27,0.1)" : "transparent",
  });

  return (
    <Box
      role="toolbar"
      aria-label={translate("padmakara.slides.toolbar.label", { _: "Line formatting" })}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 0.75,
        py: 0.5,
        backgroundColor: "background.paper",
        border: `1px solid ${slideEditorTokens.borderStrong}`,
        borderRadius: 2,
        boxShadow: "0 4px 14px rgba(31,29,27,0.12)",
        minHeight: 40,
      }}
    >
      {text ? (
        <>
          <Button
            size="small"
            color="inherit"
            onClick={(e) => setSizeAnchor(e.currentTarget)}
            aria-haspopup="menu"
            aria-label={translate("padmakara.slides.toolbar.size", { _: "Size" })}
            sx={{ minWidth: 0, color: slideEditorTokens.ink, fontSize: "0.78rem" }}
          >
            {`${translate("padmakara.slides.toolbar.size", { _: "Size" })} · ${currentSize.short} ▾`}
          </Button>
          <Menu anchorEl={sizeAnchor} open={!!sizeAnchor} onClose={() => setSizeAnchor(null)}>
            {SIZES.map((s) => (
              <MenuItem
                key={s.size}
                selected={s.size === text.size}
                onClick={() => {
                  setSizeAnchor(null);
                  onSize(s.size);
                }}
              >
                {`${s.short} · ${translate(s.key, { _: s.fallback })}`}
              </MenuItem>
            ))}
          </Menu>
          <IconButton
            size="small"
            aria-label={translate("padmakara.slides.bold", { _: "Bold" })}
            aria-pressed={marks.bold}
            onMouseDown={keepFocus}
            onClick={() => onMark("bold")}
            sx={buttonSx(marks.bold)}
          >
            <FormatBoldIcon sx={iconSx} />
          </IconButton>
          <IconButton
            size="small"
            aria-label={translate("padmakara.slides.italic", { _: "Italic" })}
            aria-pressed={marks.italic}
            onMouseDown={keepFocus}
            onClick={() => onMark("italic")}
            sx={buttonSx(marks.italic)}
          >
            <FormatItalicIcon sx={iconSx} />
          </IconButton>
          <IconButton
            size="small"
            aria-label={translate("padmakara.slides.smallCaps", { _: "Small caps" })}
            aria-pressed={!!text.smallCaps}
            onClick={onToggleSmallCaps}
            sx={buttonSx(!!text.smallCaps)}
          >
            <TextFieldsIcon sx={iconSx} />
          </IconButton>
          <IconButton
            size="small"
            aria-label={translate("padmakara.slides.dim", { _: "Dim" })}
            aria-pressed={!!text.dim}
            onClick={onToggleDim}
            sx={buttonSx(!!text.dim)}
          >
            <OpacityIcon sx={iconSx} />
          </IconButton>
        </>
      ) : (
        <Box component="span" sx={{ px: 1, fontSize: "0.78rem", color: slideEditorTokens.muted }}>
          {line
            ? translate("padmakara.slides.toolbar.otherLine", { _: "Image or space" })
            : translate("padmakara.slides.toolbar.none", { _: "Select a line on the slide" })}
        </Box>
      )}
      <IconButton
        size="small"
        disabled={!line}
        aria-label={translate("padmakara.slides.deleteLine", { _: "Delete line" })}
        onClick={onDelete}
        sx={{ borderRadius: 1, color: slideEditorTokens.muted }}
      >
        <DeleteOutlineIcon sx={iconSx} />
      </IconButton>
    </Box>
  );
};
