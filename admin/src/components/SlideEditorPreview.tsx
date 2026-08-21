/**
 * Live slide preview — renders the CURRENT slide with the shared
 * `renderSlideHtml()` from `@slides/render.ts` into a 16:9 iframe, and can
 * step through a whole sequence ("Play sequence") using each slide's real
 * duration/fade timing. This is the one and only renderer the burn container
 * also uses, so what shows here is what gets burned — see the design doc.
 */

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import type { Slide } from "@slides/types.ts";
import { renderSlideHtml } from "@slides/render.ts";

const FONT_BASE_URL = "/fonts/";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

interface SlideEditorPreviewProps {
  slides: Slide[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  resolveImageUrl: (s3Key: string) => string;
}

export const SlideEditorPreview = ({
  slides,
  selectedIndex,
  onSelectIndex,
  resolveImageUrl,
}: SlideEditorPreviewProps) => {
  const translate = useTranslate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(640);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const playToken = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setFrameWidth(Math.round(width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameHeight = Math.round((frameWidth * 9) / 16);

  const playing = playIndex != null;
  // Computed once, up front, so every render below can use a plain number
  // instead of re-deriving "which index are we actually showing" (and
  // needing a non-null assertion to do it) in several places.
  const activeIndex = playIndex != null ? playIndex : selectedIndex;
  const displayedSlide = slides[activeIndex] ?? null;
  const activeFadeMs = displayedSlide?.fadeMs ?? 800;

  const html = useMemo(() => {
    if (!displayedSlide) return null;
    return renderSlideHtml(displayedSlide, {
      width: frameWidth,
      height: frameHeight,
      fontBaseUrl: FONT_BASE_URL,
      resolveImageUrl,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedSlide, frameWidth, frameHeight, resolveImageUrl]);

  const stopPlayback = () => {
    playToken.current += 1;
    setPlayIndex(null);
    setVisible(true);
  };

  useEffect(() => stopPlayback, []);

  const playSequence = async () => {
    if (slides.length === 0) return;
    const token = ++playToken.current;
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      if (!slide || playToken.current !== token) return;
      setPlayIndex(i);
      setVisible(false);
      // Let the iframe swap content before starting the fade-in transition.
      await sleep(30);
      if (playToken.current !== token) return;
      setVisible(true);
      await sleep(slide.fadeMs);
      if (playToken.current !== token) return;
      await sleep(slide.durationMs);
      if (playToken.current !== token) return;
      setVisible(false);
      await sleep(slide.fadeMs);
    }
    if (playToken.current === token) stopPlayback();
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, position: "sticky", top: 0 }}>
      <Box
        ref={containerRef}
        sx={{
          width: "100%",
          aspectRatio: "16 / 9",
          backgroundColor: "#000",
          borderRadius: 1,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {html ? (
          <iframe
            key={`${playing ? "play" : "still"}-${activeIndex}`}
            title="Slide preview"
            srcDoc={html}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
              pointerEvents: "none",
              opacity: visible ? 1 : 0,
              transition: `opacity ${playing ? activeFadeMs : 0}ms linear`,
            }}
          />
        ) : (
          <Box
            sx={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.5)" }}>
              {translate("padmakara.slides.empty") || "No slides yet"}
            </Typography>
          </Box>
        )}
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <IconButton
          size="small"
          disabled={selectedIndex <= 0 || playing}
          onClick={() => onSelectIndex(selectedIndex - 1)}
        >
          <PlayArrowIcon sx={{ fontSize: 16, transform: "rotate(180deg)" }} />
        </IconButton>
        <Typography variant="caption" sx={{ color: "text.secondary", minWidth: 56, textAlign: "center" }}>
          {slides.length > 0
            ? translate("padmakara.slides.slideCounter", {
                current: activeIndex + 1,
                total: slides.length,
              }) || `${activeIndex + 1} / ${slides.length}`
            : "—"}
        </Typography>
        <IconButton
          size="small"
          disabled={selectedIndex >= slides.length - 1 || playing}
          onClick={() => onSelectIndex(selectedIndex + 1)}
        >
          <PlayArrowIcon sx={{ fontSize: 16 }} />
        </IconButton>

        <Box sx={{ flex: 1 }} />

        {playing ? (
          <Button
            size="small"
            color="inherit"
            startIcon={<StopIcon sx={{ fontSize: 16 }} />}
            onClick={stopPlayback}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.slides.stop") || "Stop"}
          </Button>
        ) : (
          <Button
            size="small"
            variant="outlined"
            disabled={slides.length === 0}
            startIcon={<PlayArrowIcon sx={{ fontSize: 16 }} />}
            onClick={() => void playSequence()}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            {translate("padmakara.slides.playSequence") || "Play sequence"}
          </Button>
        )}
      </Box>
    </Box>
  );
};
