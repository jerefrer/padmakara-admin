import { Hono } from "hono";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { AppError } from "../lib/errors.ts";
import { getObjectBytes } from "../services/s3.ts";
import {
  ARTWORK_QUALITY,
  ARTWORK_SIZE,
  artworkFraming,
  computeSquareCrop,
} from "../lib/teacher-artwork.ts";

/**
 * Square event-photo artwork for the lock screen and the media notification.
 *
 * Public on purpose, like the teacher artwork: the OS fetches the URL itself, without the app's
 * token. Only published events are served, so a draft's photo is not reachable by guessing ids.
 */
const eventArtworkRoutes = new Hono();

eventArtworkRoutes.get("/:id/artwork.jpg", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id)) throw AppError.notFound("Event not found");

  const event = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!event?.heroS3Key || event.status !== "published") throw AppError.notFound("Event has no photo");

  const { body } = await getObjectBytes(event.heroS3Key);
  const meta = await sharp(body).metadata();
  if (!meta.width || !meta.height) throw new Error(`Unreadable photo for event ${id}`);

  const crop = computeSquareCrop({ width: meta.width, height: meta.height, ...artworkFraming(event) });
  const jpeg = await sharp(body)
    .extract({ left: crop.left, top: crop.top, width: crop.size, height: crop.size })
    .resize(ARTWORK_SIZE, ARTWORK_SIZE)
    .jpeg({ quality: ARTWORK_QUALITY })
    .toBuffer();

  return c.body(new Uint8Array(jpeg), 200, {
    "Content-Type": "image/jpeg",
    // The URL carries ?v=<heroUpdatedAt>, so a new image or framing is a new URL.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

export { eventArtworkRoutes };
