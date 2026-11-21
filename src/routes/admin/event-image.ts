import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { events } from "../../db/schema/retreats.ts";
import { parseHeroFrameOverridesField } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import {
  putObject,
  deleteObject,
  buildEventAvatarS3Key,
  buildEventHeroS3Key,
  buildEventHeroMobileS3Key,
  buildEventHeroOriginalS3Key,
} from "../../services/s3.ts";
import { processAvatar, processAvatarFromHero, processHero, processHeroMobile } from "../../services/image-pipeline.ts";
import { loadImageSource, imageSourceResponse } from "../../lib/image-source.ts";
import { parseHeroCrop, saveHeroOriginal } from "../../lib/hero-original.ts";
import { adminEventImageFields } from "../../lib/event-image.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

/**
 * The optional event photo: /:id/avatar, /:id/hero, /:id/photo. Mirrors the retreat-group image
 * routes (admin/groups.ts), keyed by the event code under `events/{code}/images/`.
 */
const eventImageRoutes = new Hono();

function parseId(raw: string): number {
  const id = parseInt(raw, 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid event ID");
  return id;
}

async function loadEvent(id: number) {
  const event = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!event) throw AppError.notFound("Event not found");
  return event;
}

function bump(): void {
  bumpVersion("events").catch((err) => console.error("[sync] failed to bump events version:", err));
}

// FormDataEntryValue = File | string per Web API spec; avoid DOM lib dependency
function clampPercent(raw: File | string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** The current image bytes, served through the API so the admin can re-crop it. */
eventImageRoutes.get("/:id/avatar/source", async (c) => {
  const event = await loadEvent(parseId(c.req.param("id")));
  return imageSourceResponse(await loadImageSource({ s3Key: event.avatarS3Key, fallbackUrl: null }));
});

eventImageRoutes.get("/:id/hero/source", async (c) => {
  const event = await loadEvent(parseId(c.req.param("id")));
  // The original when one was kept, so re-editing can widen the crop again.
  return imageSourceResponse(
    await loadImageSource({ s3Key: event.heroOriginalS3Key ?? event.heroS3Key, fallbackUrl: null }),
  );
});

/** POST /:id/avatar — upload and resize the event photo's square thumbnail (400x400). */
eventImageRoutes.post("/:id/avatar", async (c) => {
  const id = parseId(c.req.param("id"));
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");

  const existing = await loadEvent(id);
  const resized = await processAvatar(Buffer.from(await file.arrayBuffer()));
  const s3Key = buildEventAvatarS3Key(existing.storagePrefix, "webp");
  await putObject(s3Key, resized, "image/webp");
  if (existing.avatarS3Key && existing.avatarS3Key !== s3Key) {
    await deleteObject(existing.avatarS3Key).catch(() => {});
  }

  const now = new Date();
  const [event] = await db
    .update(events)
    .set({ avatarS3Key: s3Key, avatarUpdatedAt: now, updatedAt: now })
    .where(eq(events.id, id))
    .returning();
  if (!event) throw AppError.notFound("Event not found");

  bump();
  return c.json({ ...event, ...(await adminEventImageFields(event)) });
});

/**
 * POST /:id/hero — upload the event photo (already cropped by the admin).
 *
 * multipart/form-data: `file`, optional `focalX`/`focalY`, `original`, `crop`, `grayscale`,
 * `frameOverrides` (same fields as the group hero). Writes the desktop (2400px) and mobile
 * (1200px) WebP variants, and derives the square avatar from the framing so the list thumbnail
 * follows the photo. Per-layout framing is tied to the crop being saved: it only survives if
 * the editor sent it again.
 */
eventImageRoutes.post("/:id/hero", async (c) => {
  const id = parseId(c.req.param("id"));
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");
  const focalX = clampPercent(form.get("focalX"));
  const focalY = clampPercent(form.get("focalY"));
  const crop = parseHeroCrop(form.get("crop"));
  const heroFrameOverrides = parseHeroFrameOverridesField(form.get("frameOverrides"));

  const existing = await loadEvent(id);
  const buffer = Buffer.from(await file.arrayBuffer());
  const [desktopBuf, mobileBuf, avatarBuf] = await Promise.all([
    processHero(buffer),
    processHeroMobile(buffer),
    processAvatarFromHero(buffer, { x: focalX, y: focalY }),
  ]);

  const desktopKey = buildEventHeroS3Key(existing.storagePrefix, "webp");
  const mobileKey = buildEventHeroMobileS3Key(existing.storagePrefix, "webp");
  const avatarKey = buildEventAvatarS3Key(existing.storagePrefix, "webp");
  await Promise.all([
    putObject(desktopKey, desktopBuf, "image/webp"),
    putObject(mobileKey, mobileBuf, "image/webp"),
    putObject(avatarKey, avatarBuf, "image/webp"),
  ]);

  for (const [old, next] of [
    [existing.heroS3Key, desktopKey],
    [existing.heroMobileS3Key, mobileKey],
    [existing.avatarS3Key, avatarKey],
  ] as const) {
    if (old && old !== next) await deleteObject(old).catch(() => {});
  }
  const originalColumns = await saveHeroOriginal(form, crop, existing.heroOriginalS3Key, (ext) =>
    buildEventHeroOriginalS3Key(existing.storagePrefix, ext),
  );

  const now = new Date();
  const [event] = await db
    .update(events)
    .set({
      ...originalColumns,
      heroS3Key: desktopKey,
      heroMobileS3Key: mobileKey,
      avatarS3Key: avatarKey,
      heroFocalX: focalX,
      heroFocalY: focalY,
      heroScale: 100,
      heroFrameOverrides,
      heroUpdatedAt: now,
      avatarUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(events.id, id))
    .returning();
  if (!event) throw AppError.notFound("Event not found");

  bump();
  return c.json({ ...event, ...(await adminEventImageFields(event)) });
});

/** DELETE /:id/photo — remove the event photo: the app falls back to the teachers' photos. */
eventImageRoutes.delete("/:id/photo", async (c) => {
  const id = parseId(c.req.param("id"));
  const existing = await loadEvent(id);

  for (const key of [
    existing.avatarS3Key,
    existing.heroS3Key,
    existing.heroMobileS3Key,
    existing.heroOriginalS3Key,
  ]) {
    if (key) await deleteObject(key).catch(() => {});
  }

  const [event] = await db
    .update(events)
    .set({
      avatarS3Key: null,
      heroS3Key: null,
      heroMobileS3Key: null,
      heroOriginalS3Key: null,
      heroCrop: null,
      heroGrayscale: false,
      heroFrameOverrides: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(events.id, id))
    .returning();
  if (!event) throw AppError.notFound("Event not found");

  bump();
  return c.json({ ...event, ...(await adminEventImageFields(event)) });
});

export { eventImageRoutes };
