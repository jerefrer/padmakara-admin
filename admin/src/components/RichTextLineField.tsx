/**
 * A single-line rich-text editor for a `Span[]` — bold/italic/underline
 * only, via a `contentEditable` div and the browser's native selection
 * commands. See `docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md`
 * for why this deliberately isn't a full rich-text editor dependency: the
 * model has exactly three boolean marks, so `document.execCommand` plus a
 * DOM→Span[] serialiser (`utils/richText.ts`) covers it completely.
 */

import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatUnderlinedIcon from "@mui/icons-material/FormatUnderlined";
import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import { useEffect, useRef } from "react";
import { useTranslate } from "react-admin";
import type { Span } from "@slides/types.ts";
import { domToSpans, spansToEditableHtml } from "../utils/richText";

interface RichTextLineFieldProps {
  spans: Span[];
  onChange: (spans: Span[]) => void;
  placeholder?: string;
}

export const RichTextLineField = ({ spans, onChange, placeholder }: RichTextLineFieldProps) => {
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement | null>(null);
  // Tracks whether the last edit came from inside this component so the
  // seed-from-props effect doesn't clobber the caret mid-keystroke — it only
  // needs to re-seed when `spans` changed for an external reason (switching
  // lines, loading a document, "Generate from event data").
  //
  // MUST start as null rather than the current spans' HTML: a contentEditable
  // has no React children, so the effect below is the ONLY thing that ever
  // puts text in the box. Seeding this ref with that same string made the
  // first run match and bail out, leaving the field visibly empty while the
  // document (and therefore the preview) held the real content — and the
  // next blur then serialised that empty DOM back over the real spans.
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    const html = spansToEditableHtml(spans);
    if (html === lastEmitted.current) return;
    if (ref.current && ref.current.innerHTML !== html) {
      ref.current.innerHTML = html;
    }
    lastEmitted.current = html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spans]);

  const emit = () => {
    if (!ref.current) return;
    const next = domToSpans(ref.current);
    lastEmitted.current = spansToEditableHtml(next);
    onChange(next);
  };

  const applyMark = (cmd: "bold" | "italic" | "underline") => {
    ref.current?.focus();
    document.execCommand(cmd);
    emit();
  };

  // Selection is lost the instant a button steals focus — prevent that
  // default so execCommand still has something to act on.
  const preventBlur = (e: React.MouseEvent) => e.preventDefault();

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flex: 1, minWidth: 0 }}>
      <Box sx={{ display: "flex", flexShrink: 0, gap: 0.25 }}>
        <ToggleButton
          value="bold"
          size="small"
          onMouseDown={preventBlur}
          onClick={() => applyMark("bold")}
          title={translate("padmakara.slides.bold") || "Bold"}
          sx={{ p: 0.4, border: "none" }}
        >
          <FormatBoldIcon sx={{ fontSize: 15 }} />
        </ToggleButton>
        <ToggleButton
          value="italic"
          size="small"
          onMouseDown={preventBlur}
          onClick={() => applyMark("italic")}
          title={translate("padmakara.slides.italic") || "Italic"}
          sx={{ p: 0.4, border: "none" }}
        >
          <FormatItalicIcon sx={{ fontSize: 15 }} />
        </ToggleButton>
        <ToggleButton
          value="underline"
          size="small"
          onMouseDown={preventBlur}
          onClick={() => applyMark("underline")}
          title={translate("padmakara.slides.underline") || "Underline"}
          sx={{ p: 0.4, border: "none" }}
        >
          <FormatUnderlinedIcon sx={{ fontSize: 15 }} />
        </ToggleButton>
      </Box>
      <Box
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder={placeholder}
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: "0.85rem",
          px: 1,
          py: 0.5,
          borderRadius: 1.5,
          backgroundColor: "rgba(91,94,166,0.06)",
          border: "1px solid transparent",
          minHeight: 28,
          outline: "none",
          "&:focus": {
            backgroundColor: "background.paper",
            borderColor: "primary.main",
            boxShadow: "0 0 0 2px rgba(91,94,166,0.15)",
          },
          "&:empty:before": {
            content: "attr(data-placeholder)",
            color: "text.disabled",
          },
        }}
      />
    </Box>
  );
};
