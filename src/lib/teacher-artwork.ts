import { config } from "../config.ts";
import type { HeroFrameOverrides } from "../db/schema/teachers.ts";

/** Edge length of the rendered artwork, in pixels. */
export const ARTWORK_SIZE = 800;
export const ARTWORK_QUALITY = 85;

export interface SquareCrop {
  left: number;
  top: number;
  size: number;
}

/**
 * The largest square (divided by zoom) of an image, centred on a focal point given in
 * percent of the image, then clamped so it never leaves the image.
 */
export function computeSquareCrop(input: {
  width: number;
  height: number;
  focalX: number;
  focalY: number;
  zoom?: number;
}): SquareCrop {
  const { width, height } = input;
  const zoom = Math.min(3, Math.max(1, input.zoom ?? 1));
  const size = Math.max(1, Math.floor(Math.min(width, height) / zoom));
  const cx = (Math.min(100, Math.max(0, input.focalX)) / 100) * width;
  const cy = (Math.min(100, Math.max(0, input.focalY)) / 100) * height;
  const left = Math.min(width - size, Math.max(0, Math.round(cx - size / 2)));
  const top = Math.min(height - size, Math.max(0, Math.round(cy - size / 2)));
  return { left, top, size };
}

interface ArtworkTeacher {
  id: number;
  heroS3Key: string | null;
  heroFocalX: number;
  heroFocalY: number;
  heroFrameOverrides?: HeroFrameOverrides | null;
  updatedAt: Date | string | null;
}

/**
 * The framing to square-crop with. No layout is square, but the "page" layout (390 x 380 pt)
 * is the closest, so its own framing is used when the admin set one; otherwise the hero focal point.
 */
export function artworkFraming(teacher: Pick<ArtworkTeacher, "heroFocalX" | "heroFocalY" | "heroFrameOverrides">) {
  const page = teacher.heroFrameOverrides?.page;
  if (page) return { focalX: page.focalX, focalY: page.focalY, zoom: page.zoom };
  return { focalX: teacher.heroFocalX ?? 50, focalY: teacher.heroFocalY ?? 50, zoom: 1 };
}

/**
 * Absolute URL of a teacher's square artwork, or null without a hero image. The `v` query
 * (epoch ms of updatedAt) changes with the image and its framing, so the long cache is safe.
 */
export function teacherArtworkUrl(teacher: ArtworkTeacher | null | undefined): string | null {
  if (!teacher?.heroS3Key) return null;
  const updated = teacher.updatedAt ? new Date(teacher.updatedAt).getTime() : 0;
  const base = config.urls.backend.replace(/\/+$/, "");
  return `${base}/api/teachers/${teacher.id}/artwork.jpg?v=${updated}`;
}
