import sharp from "sharp";

/**
 * Canonical image dimensions for avatar and hero rendering across the apps.
 * The same numbers are used by the live admin upload endpoints, by the
 * one-time `migrate-teacher-photos.ts` script, and by the reprocess script
 * so that every image in S3 is byte-equivalent regardless of when it was
 * uploaded.
 *
 * Output is WebP — ~25-30% smaller than equivalent-quality JPEG and
 * supported by Expo Image (used everywhere in the app) plus every browser
 * we target.
 *
 * Avatar (400×400): covers the largest current display (120px in admin,
 *   96px in the desktop sidebar) at retina 3×.
 * Hero desktop (2400×?): covers retina laptops (1200 CSS px @ 2 DPR) and
 *   most full-HD desktop displays without enlargement.
 * Hero mobile (1200×?): covers the largest phones (393 CSS px @ 3 DPR =
 *   1179 actual px); mobile clients fetch this variant instead of the
 *   desktop hero so they don't burn bandwidth on a 2400px image they
 *   cannot display.
 */
export const AVATAR_DIMENSIONS = { width: 400, height: 400, quality: 85 } as const;
export const HERO_DESKTOP_DIMENSIONS = { width: 2400, quality: 80 } as const;
export const HERO_MOBILE_DIMENSIONS = { width: 1200, quality: 80 } as const;

/**
 * Resize an image buffer to the canonical avatar shape: 400×400 WebP with
 * the subject center-cropped. Pass `grayscale: true` to also desaturate.
 */
export async function processAvatar(
  input: Buffer,
  options: { grayscale?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp(input).resize(
    AVATAR_DIMENSIONS.width,
    AVATAR_DIMENSIONS.height,
    { fit: "cover", position: "centre" },
  );
  if (options.grayscale) pipeline = pipeline.greyscale();
  return pipeline.webp({ quality: AVATAR_DIMENSIONS.quality }).toBuffer();
}

/**
 * Resize an image buffer to the desktop hero shape: 2400px wide WebP with
 * aspect ratio preserved. Smaller sources are not enlarged.
 */
export async function processHero(
  input: Buffer,
  options: { grayscale?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp(input).resize(HERO_DESKTOP_DIMENSIONS.width, null, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (options.grayscale) pipeline = pipeline.greyscale();
  return pipeline.webp({ quality: HERO_DESKTOP_DIMENSIONS.quality }).toBuffer();
}

/**
 * Resize an image buffer to the mobile hero shape: 1200px wide WebP, aspect
 * preserved, no enlargement. Generated alongside the desktop hero so the
 * frontend can pick the right variant from `Dimensions.get('window').width`.
 */
export async function processHeroMobile(
  input: Buffer,
  options: { grayscale?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp(input).resize(HERO_MOBILE_DIMENSIONS.width, null, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (options.grayscale) pipeline = pipeline.greyscale();
  return pipeline.webp({ quality: HERO_MOBILE_DIMENSIONS.quality }).toBuffer();
}
