import type { HeroCrop } from "../db/schema/teachers.ts";
import { putObject, deleteObject } from "../services/s3.ts";
import { AppError } from "./errors.ts";

/**
 * Keeping the hero as uploaded, so it can be re-framed later.
 *
 * The admin crops the hero in the browser and uploads only the cropped region, which becomes the
 * desktop/mobile variants the apps show. Alongside it, it uploads the original file the first time
 * (field `original`), plus the crop rectangle in pixels of that original (`crop`, JSON) and the
 * black-and-white choice (`grayscale`). Re-editing then starts from the original with the same
 * crop, zoom and colour instead of from an already-cropped image.
 */

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

/** Extension for the stored original: from its MIME type, else from its file name. */
export function heroOriginalExtension(mimeType: string, fileName: string): string {
  const known = EXTENSIONS[mimeType.toLowerCase()];
  if (known) return known;
  const fromName = fileName.split(".").pop()?.toLowerCase();
  return fromName && /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : "img";
}

/** Parse the `crop` form field. Absent → null; malformed → 400. */
export function parseHeroCrop(raw: File | string | null): HeroCrop | null {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") throw AppError.badRequest("Invalid crop", "INVALID_CROP");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw AppError.badRequest("Invalid crop", "INVALID_CROP");
  }
  const { x, y, width, height } = (value ?? {}) as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw AppError.badRequest("Invalid crop", "INVALID_CROP");
  }
  const crop = { x, y, width, height } as HeroCrop; // every field checked as a finite number above
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
    throw AppError.badRequest("Invalid crop", "INVALID_CROP");
  }
  return crop;
}

export interface HeroEditColumns {
  heroOriginalS3Key: string | null;
  heroCrop: HeroCrop | null;
  heroGrayscale: boolean;
}

/**
 * Store the original sent with a hero upload (if any) and return the columns to write.
 * Without a new original, the one already stored is kept: the admin only re-framed it.
 */
export async function saveHeroOriginal(
  form: FormData,
  crop: HeroCrop | null,
  existingOriginalKey: string | null | undefined,
  buildKey: (ext: string) => string,
): Promise<HeroEditColumns> {
  const grayscale = form.get("grayscale") === "true";
  const original = form.get("original");
  if (!(original instanceof File)) {
    return { heroOriginalS3Key: existingOriginalKey ?? null, heroCrop: crop, heroGrayscale: grayscale };
  }

  const contentType = original.type || "application/octet-stream";
  const key = buildKey(heroOriginalExtension(original.type, original.name));
  await putObject(key, Buffer.from(await original.arrayBuffer()), contentType);
  if (existingOriginalKey && existingOriginalKey !== key) {
    await deleteObject(existingOriginalKey).catch(() => {});
  }
  return { heroOriginalS3Key: key, heroCrop: crop, heroGrayscale: grayscale };
}
