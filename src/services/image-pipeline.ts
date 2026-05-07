import sharp from "sharp";

/**
 * Canonical image dimensions used for avatar and hero rendering across the
 * apps. The same numbers are used by the live admin upload endpoints and by
 * the one-time `migrate-teacher-photos.ts` script so newly-uploaded images
 * and migrated images are byte-for-byte equivalent.
 *
 * Avatar: 400×400 covers the largest current display (120px in admin, 96px
 *   in the desktop sidebar) at retina (2×) plus headroom.
 * Hero:   1200px-wide fits the desktop hero band at retina (2×) on a 600px
 *   container without enlarging mobile-source uploads.
 */
export const AVATAR_DIMENSIONS = { width: 400, height: 400, quality: 90 } as const;
export const HERO_DIMENSIONS = { width: 1200, quality: 85 } as const;

/**
 * Resize an image buffer to the canonical avatar shape: a 400×400 JPEG with
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
  return pipeline.jpeg({ quality: AVATAR_DIMENSIONS.quality }).toBuffer();
}

/**
 * Resize an image buffer to the canonical hero shape: 1200px wide JPEG with
 * the original aspect ratio preserved. Smaller sources are not enlarged.
 */
export async function processHero(
  input: Buffer,
  options: { grayscale?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp(input).resize(HERO_DIMENSIONS.width, null, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (options.grayscale) pipeline = pipeline.greyscale();
  return pipeline.jpeg({ quality: HERO_DIMENSIONS.quality }).toBuffer();
}
