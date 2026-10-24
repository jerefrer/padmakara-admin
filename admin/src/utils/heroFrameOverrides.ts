import type { Area } from "react-easy-crop";

/**
 * Per-frame hero framing. Frame keys are the HERO_FRAMES keys of HeroFramePreviews and the
 * HERO_FRAME_KEYS of the API; the shape is what the API stores in `hero_frame_overrides`.
 * Focal x/y are in % of the stored hero (same convention as the hero's own focal point).
 */
export type HeroFrameKey = "home" | "home-short" | "page" | "desk-home" | "desk-page";

export interface HeroFrameOverride {
  focalX: number;
  focalY: number;
  /** 1 = plain cover fit, up to MAX_FRAME_ZOOM. */
  zoom: number;
}

export type HeroFrameOverrides = Partial<Record<HeroFrameKey, HeroFrameOverride>>;

export const MIN_FRAME_ZOOM = 1;
export const MAX_FRAME_ZOOM = 3;

const FRAME_KEYS: HeroFrameKey[] = ["home", "home-short", "page", "desk-home", "desk-page"];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Read the overrides of a react-admin record, dropping anything that is not a known frame with
 * finite numbers (the API validates, but a record from an older build may carry nothing at all).
 */
export function readHeroFrameOverrides(raw: unknown): HeroFrameOverrides {
  const out: HeroFrameOverrides = {};
  if (!raw || typeof raw !== "object") return out;
  const source = raw as Record<string, unknown>;
  for (const key of FRAME_KEYS) {
    const entry = source[key];
    if (!entry || typeof entry !== "object") continue;
    const { focalX, focalY, zoom } = entry as Record<string, unknown>;
    if (![focalX, focalY, zoom].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out[key] = {
      focalX: clamp(focalX as number, 0, 100),
      focalY: clamp(focalY as number, 0, 100),
      zoom: clamp(zoom as number, MIN_FRAME_ZOOM, MAX_FRAME_ZOOM),
    };
  }
  return out;
}

export function hasHeroFrameOverrides(overrides: HeroFrameOverrides | undefined | null): boolean {
  return !!overrides && Object.keys(overrides).length > 0;
}

/** The overrides as the API stores them: values rounded, key order stable. */
export function serializeHeroFrameOverrides(overrides: HeroFrameOverrides): string {
  const out: HeroFrameOverrides = {};
  for (const key of FRAME_KEYS) {
    const o = overrides[key];
    if (!o) continue;
    out[key] = {
      focalX: Math.round(o.focalX * 10) / 10,
      focalY: Math.round(o.focalY * 10) / 10,
      zoom: Math.round(o.zoom * 100) / 100,
    };
  }
  return JSON.stringify(out);
}

/** Two crop rectangles (pixels of the original) are the same crop, give or take rounding. */
export function sameCrop(a: Area, b: Area, tolerance = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/**
 * Whether the overrides belonging to `base` still apply to `current`. They are tied to the stored
 * crop: any other crop frames different pixels, so they must be dropped.
 */
export function overridesSurviveCrop(base: Area | null, current: Area): boolean {
  return base === null || sameCrop(base, current);
}
