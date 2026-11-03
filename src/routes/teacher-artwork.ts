import { Hono } from "hono";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { AppError } from "../lib/errors.ts";
import { getObjectBytes } from "../services/s3.ts";
import {
  ARTWORK_QUALITY,
  ARTWORK_SIZE,
  artworkFraming,
  computeSquareCrop,
} from "../lib/teacher-artwork.ts";

/**
 * Square speaker artwork for the lock screen and the media notification.
 *
 * Public on purpose: the OS fetches the artwork URL itself, without the app's token,
 * and it is the same teacher photo the public events pages already show.
 */
const teacherArtworkRoutes = new Hono();

teacherArtworkRoutes.get("/:id/artwork.jpg", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id)) throw AppError.notFound("Teacher not found");

  const teacher = await db.query.teachers.findFirst({ where: eq(teachers.id, id) });
  if (!teacher?.heroS3Key) throw AppError.notFound("Teacher has no hero image");

  const { body } = await getObjectBytes(teacher.heroS3Key);
  const meta = await sharp(body).metadata();
  if (!meta.width || !meta.height) throw new Error(`Unreadable hero image for teacher ${id}`);

  const crop = computeSquareCrop({ width: meta.width, height: meta.height, ...artworkFraming(teacher) });
  const jpeg = await sharp(body)
    .extract({ left: crop.left, top: crop.top, width: crop.size, height: crop.size })
    .resize(ARTWORK_SIZE, ARTWORK_SIZE)
    .jpeg({ quality: ARTWORK_QUALITY })
    .toBuffer();

  return c.body(new Uint8Array(jpeg), 200, {
    "Content-Type": "image/jpeg",
    // The URL carries ?v=<updatedAt>, so a new image or framing is a new URL.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

export { teacherArtworkRoutes };
