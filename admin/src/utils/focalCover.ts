/**
 * True focal centring with cover fit. Must stay identical to the mobile app
 * (utils/focalCover.ts there, same shared test cases):
 * the focal point is placed at the frame centre, clamped so the image still
 * covers the whole frame. `zoom` (1..3, default 1) enlarges the cover size
 * before centring; zoom 1 is the plain cover fit.
 */
export interface FocalCoverInput {
  frameWidth: number;
  frameHeight: number;
  imageWidth: number;
  imageHeight: number;
  /** Focal point in % of the image, 0..100. */
  focalX: number;
  focalY: number;
  /** Per-frame zoom on top of the cover fit, 1 = plain cover. */
  zoom?: number;
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
  const zoom = Number.isFinite(input.zoom) ? clampRange(input.zoom as number, 1, 3) : 1;
  const valid = [frameWidth, frameHeight, imageWidth, imageHeight].every(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (!valid) {
    return { width: frameWidth || 0, height: frameHeight || 0, offsetX: 0, offsetY: 0 };
  }
  const s = Math.max(frameWidth / imageWidth, frameHeight / imageHeight) * zoom;
  const width = imageWidth * s;
  const height = imageHeight * s;
  const fx = clampRange(Number.isFinite(focalX) ? focalX : 50, 0, 100);
  const fy = clampRange(Number.isFinite(focalY) ? focalY : 50, 0, 100);
  const offsetX = clampRange(frameWidth / 2 - (fx / 100) * width, Math.min(0, frameWidth - width), 0);
  const offsetY = clampRange(frameHeight / 2 - (fy / 100) * height, Math.min(0, frameHeight - height), 0);
  return { width, height, offsetX, offsetY };
}

/**
 * The focal point after dragging the image by (dx, dy) frame units from its current placement.
 * Starts from the placement actually shown (which may be clamped), so the image follows the
 * pointer without a jump; an axis with no slack keeps its focal value.
 */
export function focalAfterPan(
  input: FocalCoverInput,
  dx: number,
  dy: number,
): { focalX: number; focalY: number } {
  const placed = focalCoverPosition(input);
  const axis = (frame: number, size: number, offset: number, delta: number, current: number) => {
    if (size - frame <= 0.0001 || !(size > 0)) return current;
    return clampRange(((frame / 2 - (offset + delta)) / size) * 100, 0, 100);
  };
  return {
    focalX: axis(input.frameWidth, placed.width, placed.offsetX, dx, input.focalX),
    focalY: axis(input.frameHeight, placed.height, placed.offsetY, dy, input.focalY),
  };
}
