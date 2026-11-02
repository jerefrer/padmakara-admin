/**
 * The large slide in the centre of the editor, editable in place.
 *
 * It renders the slide with the shared `renderSlideHtml()` (the same HTML and
 * CSS the burn uses, plus selection outlines through `extraCss`) into a 16:9
 * iframe, then makes each text line `contentEditable` from the parent. Typing
 * is read back with `domToSpans` and reported as `onChangeSpans`; the iframe is
 * NOT re-rendered for those edits, or the caret would jump. Anything else that
 * changes the slide (size, small caps, another slide) re-renders it and the
 * selected line is focused again.
 */

import Box from "@mui/material/Box";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { BUILTIN_CLIPS, isClipSlide, type BuiltinClipId, type Slide, type Span } from "@slides/types.ts";
import { renderSlideHtml } from "@slides/render.ts";
import { slideEditorTokens } from "../slideEditorTokens";
import { domToSpans, isLineBreakKey } from "../utils/richText";
import { CANVAS_EDIT_CSS, canKeepCanvasDocument, cleanEditedSpans } from "../utils/slideCanvas";

const FONT_BASE_URL = "/fonts/";

export type CanvasMark = "bold" | "italic";

/** What the toolbar can ask of the canvas. */
export interface SlideCanvasHandle {
  /** Toggle a mark on the selection inside the selected line. */
  applyMark: (mark: CanvasMark) => void;
}

interface SlideCanvasProps {
  slide: Slide | null;
  selectedLineId: string | null;
  onSelectLine: (lineId: string | null) => void;
  onChangeSpans: (lineId: string, spans: Span[]) => void;
  /** Bold/italic state at the caret, for the toolbar's pressed state. */
  onMarksChange?: (marks: Record<CanvasMark, boolean>) => void;
  resolveImageUrl: (s3Key: string) => string;
  resolveClipUrl: (clip: BuiltinClipId) => string;
  emptyLabel: string;
  frameLabel: string;
}

export const SlideCanvas = forwardRef<SlideCanvasHandle, SlideCanvasProps>(function SlideCanvas(
  { slide, selectedLineId, onSelectLine, onChangeSpans, onMarksChange, resolveImageUrl, resolveClipUrl, emptyLabel, frameLabel },
  ref,
) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(720);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setFrameWidth(Math.round(width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameHeight = Math.round((frameWidth * 9) / 16);

  // The iframe document is replaced only when the change is more than the
  // text of the line being typed in.
  const rendered = useRef<{ slide: Slide | null; width: number; resolve: unknown; html: string | null }>({
    slide: null,
    width: 0,
    resolve: null,
    html: null,
  });
  const editingLineRef = useRef<string | null>(null);

  const html = useMemo(() => {
    const prev = rendered.current;
    if (!slide || isClipSlide(slide)) {
      rendered.current = { slide, width: frameWidth, resolve: resolveImageUrl, html: null };
      return null;
    }
    const keep =
      prev.html !== null &&
      prev.slide !== null &&
      prev.width === frameWidth &&
      prev.resolve === resolveImageUrl &&
      canKeepCanvasDocument(prev.slide, slide, editingLineRef.current);
    if (keep) {
      rendered.current = { ...prev, slide };
      return prev.html;
    }
    const next = renderSlideHtml(slide, {
      width: frameWidth,
      height: frameHeight,
      fontBaseUrl: FONT_BASE_URL,
      resolveImageUrl,
      extraCss: CANVAS_EDIT_CSS,
      lineIds: true,
    });
    rendered.current = { slide, width: frameWidth, resolve: resolveImageUrl, html: next };
    return next;
  }, [slide, frameWidth, frameHeight, resolveImageUrl]);

  // Latest props for the listeners attached once per iframe load.
  const latest = useRef({ onSelectLine, onChangeSpans, onMarksChange, selectedLineId });
  latest.current = { onSelectLine, onChangeSpans, onMarksChange, selectedLineId };

  const frameDoc = (): Document | null => iframeRef.current?.contentDocument ?? null;

  const lineElement = (id: string | null): HTMLElement | null => {
    if (!id) return null;
    return frameDoc()?.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(id)}"]`) ?? null;
  };

  const reportMarks = useCallback(() => {
    const doc = frameDoc();
    if (!doc) return;
    latest.current.onMarksChange?.({
      bold: doc.queryCommandState("bold"),
      italic: doc.queryCommandState("italic"),
    });
  }, []);

  const emit = (el: HTMLElement) => {
    const id = el.dataset.lineId;
    if (!id) return;
    editingLineRef.current = id;
    latest.current.onChangeSpans(id, cleanEditedSpans(domToSpans(el)));
  };

  const markSelected = useCallback((id: string | null) => {
    const doc = frameDoc();
    if (!doc) return;
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[data-line-id]"))) {
      if (el.dataset.lineId === id) el.setAttribute("data-selected", "true");
      else el.removeAttribute("data-selected");
    }
  }, []);

  const handleLoad = () => {
    const doc = frameDoc();
    if (!doc) return;
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(".text-line"))) {
      el.contentEditable = "true";
      el.spellcheck = false;
    }

    const lineOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof doc.defaultView!.Element ? (target.closest<HTMLElement>("[data-line-id]") as HTMLElement | null) : null;

    doc.addEventListener("click", (e) => {
      const el = lineOf(e.target);
      latest.current.onSelectLine(el?.dataset.lineId ?? null);
    });
    doc.addEventListener("focusin", (e) => {
      const el = lineOf(e.target);
      if (el?.dataset.lineId && el.dataset.lineId !== latest.current.selectedLineId) {
        latest.current.onSelectLine(el.dataset.lineId);
      }
    });
    doc.addEventListener("input", (e) => {
      const el = lineOf(e.target);
      if (el?.classList.contains("text-line")) emit(el);
    });
    doc.addEventListener("keydown", (e) => {
      const el = lineOf(e.target);
      if (!el?.classList.contains("text-line") || !isLineBreakKey(e)) return;
      // Enter is a soft line break inside the line, never a new block.
      e.preventDefault();
      doc.execCommand("insertLineBreak");
      emit(el);
    });
    doc.addEventListener("selectionchange", reportMarks);

    markSelected(latest.current.selectedLineId);
    const selected = lineElement(latest.current.selectedLineId);
    if (selected?.isContentEditable) {
      selected.focus();
      const range = doc.createRange();
      range.selectNodeContents(selected);
      range.collapse(false);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  useEffect(() => {
    markSelected(selectedLineId);
    // Selecting another line ends the typing run on the previous one.
    if (editingLineRef.current !== selectedLineId) editingLineRef.current = null;
  }, [selectedLineId, markSelected]);

  useImperativeHandle(ref, () => ({
    applyMark: (mark) => {
      const doc = frameDoc();
      const el = lineElement(latest.current.selectedLineId);
      if (!doc || !el?.isContentEditable) return;
      el.focus();
      doc.execCommand(mark);
      emit(el);
      reportMarks();
    },
  }));

  const clip = slide && isClipSlide(slide) && slide.clip ? slide.clip : null;

  return (
    <Box
      ref={frameRef}
      sx={{
        width: "100%",
        aspectRatio: "16 / 9",
        backgroundColor: "#000",
        borderRadius: 1,
        overflow: "hidden",
        position: "relative",
        boxShadow: `0 1px 0 ${slideEditorTokens.borderStrong}, 0 8px 24px rgba(31,29,27,0.18)`,
      }}
    >
      {clip ? (
        <video
          key={slide?.id}
          src={resolveClipUrl(clip)}
          title={BUILTIN_CLIPS[clip].filename}
          controls
          muted
          playsInline
          preload="metadata"
          style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
        />
      ) : html ? (
        <iframe
          ref={iframeRef}
          title={frameLabel}
          srcDoc={html}
          onLoad={handleLoad}
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        />
      ) : (
        <Box sx={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Box component="span" sx={{ color: "rgba(255,255,255,0.5)", fontSize: "0.75rem" }}>
            {emptyLabel}
          </Box>
        </Box>
      )}
    </Box>
  );
});
