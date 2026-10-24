/**
 * How sharp a hero will look, from the width of the cropped region.
 *
 * File size does not matter: the server re-encodes every hero to WebP at 2400 px wide (desktop)
 * and 1200 px wide (phones), never enlarging. What matters is how many pixels the crop keeps.
 * Widths follow HERO_DESKTOP_DIMENSIONS / HERO_MOBILE_DIMENSIONS in src/services/image-pipeline.ts.
 */

export const HERO_DESKTOP_WIDTH = 2400;
export const HERO_MOBILE_WIDTH = 1200;

export type HeroResolutionLevel = "good" | "fair" | "poor";

export interface HeroResolutionAdvice {
  level: HeroResolutionLevel;
  message: string;
}

export function heroResolutionAdvice(cropWidth: number): HeroResolutionAdvice {
  const width = Math.round(cropWidth);
  if (width >= HERO_DESKTOP_WIDTH) {
    return { level: "good", message: `${width} px wide: sharp on every screen.` };
  }
  if (width >= HERO_MOBILE_WIDTH) {
    return {
      level: "fair",
      message: `${width} px wide: sharp on phones, slightly soft on large computer screens (${HERO_DESKTOP_WIDTH} px is ideal).`,
    };
  }
  return {
    level: "poor",
    message: `${width} px wide: may look blurry. Use a larger photo or zoom out (at least ${HERO_MOBILE_WIDTH} px, ideally ${HERO_DESKTOP_WIDTH} px).`,
  };
}

const LEVEL_RANK: Record<HeroResolutionLevel, number> = { good: 2, fair: 1, poor: 0 };

/**
 * Sharpness of one app frame zoomed by `zoom` (1..3): the frame shows 1/zoom of the crop's width.
 * `degraded` is true when the zoom alone made it worse than the unzoomed frame, which is what a
 * frame caption should flag (a small crop is already reported once, for the whole hero).
 */
export function heroFrameResolutionAdvice(
  cropWidth: number,
  zoom: number,
): HeroResolutionAdvice & { degraded: boolean } {
  const advice = heroResolutionAdvice(cropWidth / Math.max(1, zoom));
  const base = heroResolutionAdvice(cropWidth);
  return { ...advice, degraded: LEVEL_RANK[advice.level] < LEVEL_RANK[base.level] };
}
