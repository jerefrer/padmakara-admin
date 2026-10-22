/**
 * True focal centring with cover fit. Must stay identical to the mobile app:
 * the focal point is placed at the frame centre, clamped so the image still
 * covers the whole frame.
 */
export interface FocalCoverInput {
  frameWidth: number;
  frameHeight: number;
  imageWidth: number;
  imageHeight: number;
  /** Focal point in % of the image, 0..100. */
  focalX: number;
  focalY: number;
}

export interface FocalCoverResult {
  /** Rendered image size (cover fit), in frame units. */
  width: number;
  height: number;
  /** Image offset relative to the frame's top-left corner (<= 0). */
  offsetX: number;
  offsetY: number;
}

function clampRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function focalCoverPosition(input: FocalCoverInput): FocalCoverResult {
  const { frameWidth, frameHeight, imageWidth, imageHeight, focalX, focalY } = input;
  const valid = [frameWidth, frameHeight, imageWidth, imageHeight].every(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (!valid) {
    return { width: frameWidth || 0, height: frameHeight || 0, offsetX: 0, offsetY: 0 };
  }
  const s = Math.max(frameWidth / imageWidth, frameHeight / imageHeight);
  const width = imageWidth * s;
  const height = imageHeight * s;
  const fx = clampRange(Number.isFinite(focalX) ? focalX : 50, 0, 100);
  const fy = clampRange(Number.isFinite(focalY) ? focalY : 50, 0, 100);
  const offsetX = clampRange(frameWidth / 2 - (fx / 100) * width, Math.min(0, frameWidth - width), 0);
  const offsetY = clampRange(frameHeight / 2 - (fy / 100) * height, Math.min(0, frameHeight - height), 0);
  return { width, height, offsetX, offsetY };
}
