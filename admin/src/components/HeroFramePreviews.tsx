import { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";
import type { Area } from "react-easy-crop";
import { focalCoverPosition } from "../utils/focalCover";

/**
 * A real frame of the mobile / desktop app, in app points. `statusBar` is the
 * height of the area under the status bar that the hero is drawn behind;
 * `circles` hints at the content-type circles overlapping the bottom-right.
 */
interface FrameSpec {
  key: string;
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
  // app/(tabs)/(groups)/index.tsx featuredImageContainer: width 100% of a 390 pt phone, aspectRatio 16/10.
  { key: "home", label: "Home - highlight", width: 390, height: 244, scale: 0.4 },
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
}

export function HeroFramePreviews({ imageUrl, crop: cropProp, focal, grayscale }: Props) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

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
        const placed = focalCoverPosition({
          frameWidth: f.width,
          frameHeight: f.height,
          imageWidth: crop.width,
          imageHeight: crop.height,
          focalX: focal.x,
          focalY: focal.y,
        });
        const k = (placed.width / crop.width) * f.scale; // original px -> preview px
        const w = f.width * f.scale;
        const h = f.height * f.scale;
        return (
          <Box key={f.key} sx={{ textAlign: "center" }}>
            <Box
              sx={{
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
            <Typography variant="caption" color="text.disabled" sx={{ display: "block", fontSize: 10 }}>
              {f.width} x {f.height}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}
