import type { Area } from "react-easy-crop";
import { hasHeroFrameOverrides, readHeroFrameOverrides, serializeHeroFrameOverrides, type HeroFrameOverrides } from "./heroFrameOverrides";

/**
 * Re-editable heroes (teachers and retreat groups).
 *
 * The server keeps the hero as uploaded, with the crop rectangle (in pixels of that original) and
 * the black-and-white choice. Re-opening the editor loads the original and restores both, so a
 * crop can always be widened again or colour brought back.
 */

/** What the editor needs to reopen a hero as it was saved. */
export interface StoredHeroEdit {
  initialCrop?: Area;
  initialGrayscale?: boolean;
  /** Per-frame framing saved with that crop. Only set when the crop is restored: it is tied to it. */
  initialFrameOverrides?: HeroFrameOverrides;
  /** The file loaded into the editor is the stored original: it is not uploaded again. */
  storedOriginal: boolean;
}

/** A react-admin teacher or group record: only its hero fields are read. */
type HeroRecord = Record<string, unknown>;

function isArea(value: unknown): value is Area {
  if (!value || typeof value !== "object") return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Read the saved crop of a hero record. Heroes saved before originals were kept have none: the
 * editor then opens the stored (already cropped) image, which becomes the original on save.
 */
export function storedHeroEdit(record: HeroRecord): StoredHeroEdit {
  if (typeof record.heroOriginalS3Key !== "string" || !record.heroOriginalS3Key) {
    return { storedOriginal: false };
  }
  const initialCrop = isArea(record.heroCrop) ? record.heroCrop : undefined;
  return {
    storedOriginal: true,
    initialCrop,
    initialGrayscale: record.heroGrayscale === true,
    // Per-frame framing is tied to the saved crop: without it the editor cannot tell if it still fits.
    initialFrameOverrides: initialCrop ? readHeroFrameOverrides(record.heroFrameOverrides) : undefined,
  };
}

/** The fields sent with a hero upload so the server keeps the original and the crop. */
export interface HeroEditUpload {
  /** Uploaded only when the editor did not start from the stored original. */
  original: File | null;
  crop: Area;
  grayscale: boolean;
  /** Per-frame framing for this crop. Left out when no frame has its own. */
  frameOverrides?: HeroFrameOverrides;
}

export function appendHeroEdit(form: FormData, edit: HeroEditUpload): void {
  if (edit.original) form.append("original", edit.original, edit.original.name);
  form.append(
    "crop",
    JSON.stringify({
      x: Math.round(edit.crop.x),
      y: Math.round(edit.crop.y),
      width: Math.round(edit.crop.width),
      height: Math.round(edit.crop.height),
    }),
  );
  form.append("grayscale", String(edit.grayscale));
  if (hasHeroFrameOverrides(edit.frameOverrides)) {
    form.append("frameOverrides", serializeHeroFrameOverrides(edit.frameOverrides!));
  }
}
