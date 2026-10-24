import { useEffect, useRef, useState } from "react";
import { Box, Chip, Link, Slider, Typography } from "@mui/material";
import type { Area } from "react-easy-crop";
import { focalAfterPan, focalCoverPosition } from "../utils/focalCover";
import { heroFrameResolutionAdvice } from "../utils/heroResolution";
import {
  MAX_FRAME_ZOOM,
  MIN_FRAME_ZOOM,
  type HeroFrameKey,
  type HeroFrameOverride,
  type HeroFrameOverrides,
} from "../utils/heroFrameOverrides";

/**
 * A real frame of the mobile / desktop app, in app points. `statusBar` is the
 * height of the area under the status bar that the hero is drawn behind;
 * `circles` hints at the content-type circles overlapping the bottom-right.
 */
interface FrameSpec {
  key: HeroFrameKey;
  label: string;
  width: number;
  height: number;
  /** Display scale (preview px per app point). */
  scale: number;
  statusBar?: number;
  circles?: boolean;
}

// Geometry copied from padmakara-app (see the file:line notes per frame).
export const HERO_FRAMES: FrameSpec[] = [
  // app/(tabs)/(groups)/index.tsx featuredImageContainer: width 100% of a 390 pt phone, aspectRatio 3/2.
  { key: "home", label: "Home - highlight", width: 390, height: 260, scale: 0.4 },
  // featuredImageContainerShort: aspectRatio 2, used when window height < 750 (SHORT_SCREEN_HEIGHT).
  { key: "home-short", label: "Home - small phones", width: 375, height: 187.5, scale: 0.4 },
  // retreat/[id].tsx, teacher/[abbreviation].tsx, retreats/[code].tsx: HERO_HEIGHT 380, drawn under the status bar.
  { key: "page", label: "Event / teacher / group page", width: 390, height: 380, scale: 0.4, statusBar: 59, circles: true },
  // featuredImageContainerDesktop: 45% of the home card at a 1440 pt window (main pane 1440 - 280 sidebar
  // - 220 right rail, minus 2 x 24 padding = 892), minHeight 280 (taller only with a long info column).
  { key: "desk-home", label: "Desktop - highlight", width: 400, height: 280, scale: 0.4 },
  // retreat/[id].tsx on desktop: heroContainer height 380; at a 1440 pt window the column is
  // 1440 - 280 sidebar - 64 collapsed rail - 320 related events = 776 (app/(tabs)/_layout.tsx, (groups)/_layout.tsx).
  { key: "desk-page", label: "Desktop - event page", width: 776, height: 380, scale: 0.3 },
];

interface Props {
  imageUrl: string;
  /**
   * Current crop region, in pixels of the original image. "whole" for an image that is already
   * the cropped hero (the stored one shown on the edit page).
   */
  crop: Area | "whole" | null;
  /** Focal point in % of the cropped region. */
  focal: { x: number; y: number };
  grayscale: boolean;
  /** Frames that carry their own framing; the others follow `focal`. */
  overrides?: HeroFrameOverrides;
  /**
   * When given, the frames are adjustable: drag a frame to pan it, use its slider to zoom, and
   * "Reset" to follow the focal point again. Without it the previews are read-only.
   */
  onOverridesChange?: (next: HeroFrameOverrides) => void;
}

const RESOLUTION_COLORS = { good: "text.secondary", fair: "warning.main", poor: "error.main" } as const;

interface PanStart {
  pointerX: number;
  pointerY: number;
  override: HeroFrameOverride;
}

export function HeroFramePreviews({ imageUrl, crop: cropProp, focal, grayscale, overrides, onOverridesChange }: Props) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const panRef = useRef<PanStart | null>(null);
  const editable = !!onOverridesChange;

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  if (!natural) return null;
  const crop = cropProp === "whole" ? { x: 0, y: 0, width: natural.w, height: natural.h } : cropProp;
  if (!crop || crop.width <= 0 || crop.height <= 0) return null;

  return (
    <Box sx={{ width: "100%", display: "flex", flexWrap: "wrap", gap: 2, alignItems: "flex-end", justifyContent: "center" }}>
      {HERO_FRAMES.map((f) => {
        // Focal math on the stored hero (the crop region), then express the
        // original image relative to that placement.
        const override = overrides?.[f.key];
        const effective: HeroFrameOverride = override ?? { focalX: focal.x, focalY: focal.y, zoom: 1 };
        const placeInput = {
          frameWidth: f.width,
          frameHeight: f.height,
          imageWidth: crop.width,
          imageHeight: crop.height,
          focalX: effective.focalX,
          focalY: effective.focalY,
          zoom: effective.zoom,
        };
        const placed = focalCoverPosition(placeInput);
        const advice = heroFrameResolutionAdvice(crop.width, effective.zoom);
        const setOverride = (next: HeroFrameOverride | null) => {
          if (!onOverridesChange) return;
          const rest = { ...overrides };
          if (next) rest[f.key] = next;
          else delete rest[f.key];
          onOverridesChange(rest);
        };
        const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
          if (!editable) return;
          e.preventDefault();
          panRef.current = { pointerX: e.clientX, pointerY: e.clientY, override: effective };
          e.currentTarget.setPointerCapture(e.pointerId);
        };
        const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
          const start = panRef.current;
          if (!start) return;
          const next = focalAfterPan(
            { ...placeInput, focalX: start.override.focalX, focalY: start.override.focalY },
            (e.clientX - start.pointerX) / f.scale,
            (e.clientY - start.pointerY) / f.scale,
          );
          setOverride({ ...start.override, ...next });
        };
        const onPanEnd = (e: React.PointerEvent<HTMLDivElement>) => {
          if (!panRef.current) return;
          panRef.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        };
        const k = (placed.width / crop.width) * f.scale; // original px -> preview px
        const w = f.width * f.scale;
        const h = f.height * f.scale;
        return (
          <Box key={f.key} sx={{ textAlign: "center" }} data-frame={f.key}>
            <Box
              onPointerDown={onPanStart}
              onPointerMove={onPanMove}
              onPointerUp={onPanEnd}
              onPointerCancel={onPanEnd}
              sx={{
                cursor: editable ? "grab" : "inherit",
                touchAction: editable ? "none" : "auto",
                "&:active": editable ? { cursor: "grabbing" } : undefined,
                position: "relative",
                width: w,
                height: h,
                overflow: "hidden",
                bgcolor: "#222",
                borderRadius: 1,
                outline: "1px solid rgba(0,0,0,0.25)",
              }}
            >
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  backgroundImage: `url(${imageUrl})`,
                  backgroundRepeat: "no-repeat",
                  backgroundSize: `${natural.w * k}px ${natural.h * k}px`,
                  backgroundPosition: `${placed.offsetX * f.scale - crop.x * k}px ${placed.offsetY * f.scale - crop.y * k}px`,
                  filter: grayscale ? "grayscale(1)" : "none",
                }}
              />
              {f.statusBar ? (
                <Box
                  sx={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: f.statusBar * f.scale,
                    bgcolor: "rgba(0,0,0,0.35)",
                    borderBottom: "1px dashed rgba(255,255,255,0.7)",
                    color: "white",
                    fontSize: 8,
                    lineHeight: `${f.statusBar * f.scale}px`,
                    textAlign: "center",
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  Status bar
                </Box>
              ) : null}
              {f.circles ? (
                <Box sx={{ position: "absolute", right: 6, bottom: 6, display: "flex", gap: 0.5 }}>
                  {[0, 1, 2].map((i) => (
                    <Box key={i} sx={{ width: 14, height: 14, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.9)" }} />
                  ))}
                </Box>
              ) : null}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {f.label}
            </Typography>
            <Typography
              variant="caption"
              title={advice.degraded ? advice.message : undefined}
              sx={{
                display: "block",
                fontSize: 10,
                color: advice.degraded ? RESOLUTION_COLORS[advice.level] : "text.disabled",
              }}
            >
              {f.width} x {f.height}
              {advice.degraded ? ` - ${Math.round(crop.width / effective.zoom)} px wide` : ""}
            </Typography>
            {editable ? (
              <Box sx={{ width: f.width * f.scale, mx: "auto" }}>
                <Slider
                  size="small"
                  value={effective.zoom}
                  min={MIN_FRAME_ZOOM}
                  max={MAX_FRAME_ZOOM}
                  step={0.05}
                  onChange={(_, v) => setOverride({ ...effective, zoom: v as number })}
                  aria-label={`Zoom - ${f.label}`}
                  sx={{ py: 0.5, display: "block" }}
                />
              </Box>
            ) : null}
            {override ? (
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1 }}>
                <Chip size="small" label="Custom" color="primary" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                {editable ? (
                  <Link component="button" type="button" variant="caption" onClick={() => setOverride(null)}>
                    Reset
                  </Link>
                ) : null}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
