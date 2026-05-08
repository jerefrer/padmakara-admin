import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { createTeacherSchema, updateTeacherSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  putObject,
  deleteObject,
  buildTeacherAvatarS3Key,
  buildTeacherHeroS3Key,
  buildTeacherHeroMobileS3Key,
} from "../../services/s3.ts";
import {
  processAvatar,
  processHero,
  processHeroMobile,
} from "../../services/image-pipeline.ts";
import { resolveTeacherUrls } from "../../lib/teacher-utils.ts";
import { bumpVersion } from "../../services/sync-versions.ts";

const teacherRoutes = new Hono();

const columns: Record<string, any> = {
  id: teachers.id,
  name: teachers.name,
  abbreviation: teachers.abbreviation,
  createdAt: teachers.createdAt,
};

teacherRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(teachers.name, `%${q}%`),
        ilike(teachers.abbreviation, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(teachers).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(teachers, where),
  ]);

  const resolved = await Promise.all(
    data.map(async (t) => ({ ...t, ...(await resolveTeacherUrls(t)) })),
  );
  return listResponse(c, resolved, total, offset, offset + limit, "teachers");
});

/**
 * POST /:id/avatar — Upload and resize a teacher avatar.
 *
 * Accepts multipart/form-data with a `file` field. The server resizes the
 * upload to 400×400 (sharp center-cover) before storing on S3 so the app
 * always serves a small, correctly-sized image regardless of source size.
 * Pass `grayscale=true` to also desaturate the result.
 */
teacherRoutes.post("/:id/avatar", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid teacher ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");
  const grayscale = form.get("grayscale") === "true";

  const buffer = Buffer.from(await file.arrayBuffer());
  const resized = await processAvatar(buffer, { grayscale });

  const s3Key = buildTeacherAvatarS3Key(id, "webp");
  await putObject(s3Key, resized, "image/webp");

  const existing = await db.query.teachers.findFirst({
    where: eq(teachers.id, id),
  });
  if (existing?.avatarS3Key && existing.avatarS3Key !== s3Key) {
    await deleteObject(existing.avatarS3Key).catch(() => {});
  }

  const now = new Date();
  const [teacher] = await db
    .update(teachers)
    .set({ avatarS3Key: s3Key, avatarUpdatedAt: now, updatedAt: now })
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");

  const resolved = await resolveTeacherUrls(teacher);
  bumpVersion("teachers").catch((err) =>
    console.error("[sync] failed to bump teachers version:", err),
  );
  return c.json({ ...teacher, ...resolved });
});

/**
 * POST /:id/hero — Upload and resize a teacher hero banner.
 *
 * Accepts multipart/form-data with `file`, optional `focalX`/`focalY`
 * (0–100, default 50), and optional `grayscale`. The server generates two
 * WebP variants — desktop (2400px wide) and mobile (1200px wide) — both
 * with aspect ratio preserved and no enlargement. Frontend picks the right
 * one from the viewport width. Focal coordinates are display metadata used
 * by the apps' object-position styling.
 */
teacherRoutes.post("/:id/hero", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid teacher ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");
  const focalX = clampPercent(form.get("focalX"));
  const focalY = clampPercent(form.get("focalY"));
  const grayscale = form.get("grayscale") === "true";

  const buffer = Buffer.from(await file.arrayBuffer());
  const [desktopBuf, mobileBuf] = await Promise.all([
    processHero(buffer, { grayscale }),
    processHeroMobile(buffer, { grayscale }),
  ]);

  const desktopKey = buildTeacherHeroS3Key(id, "webp");
  const mobileKey = buildTeacherHeroMobileS3Key(id, "webp");
  await Promise.all([
    putObject(desktopKey, desktopBuf, "image/webp"),
    putObject(mobileKey, mobileBuf, "image/webp"),
  ]);

  const existing = await db.query.teachers.findFirst({
    where: eq(teachers.id, id),
  });
  if (existing?.heroS3Key && existing.heroS3Key !== desktopKey) {
    await deleteObject(existing.heroS3Key).catch(() => {});
  }
  if (existing?.heroMobileS3Key && existing.heroMobileS3Key !== mobileKey) {
    await deleteObject(existing.heroMobileS3Key).catch(() => {});
  }

  const now = new Date();
  const [teacher] = await db
    .update(teachers)
    .set({
      heroS3Key: desktopKey,
      heroMobileS3Key: mobileKey,
      heroFocalX: focalX,
      heroFocalY: focalY,
      heroScale: 100,
      heroUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");

  const resolved = await resolveTeacherUrls(teacher);
  bumpVersion("teachers").catch((err) =>
    console.error("[sync] failed to bump teachers version:", err),
  );
  return c.json({ ...teacher, ...resolved });
});

function clampPercent(raw: FormDataEntryValue | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

teacherRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const teacher = await db.query.teachers.findFirst({
    where: eq(teachers.id, id),
  });
  if (!teacher) throw AppError.notFound("Teacher not found");
  const resolved = await resolveTeacherUrls(teacher);
  return c.json({ ...teacher, ...resolved });
});

teacherRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createTeacherSchema.parse(body);
  const [teacher] = await db.insert(teachers).values(data).returning();
  bumpVersion("teachers").catch((err) =>
    console.error("[sync] failed to bump teachers version:", err),
  );
  return c.json(teacher!, 201);
});

teacherRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateTeacherSchema.parse(body);

  // If S3 keys are changing, we need to delete old objects
  if (data.avatarS3Key !== undefined || data.heroS3Key !== undefined) {
    const existing = await db.query.teachers.findFirst({
      where: eq(teachers.id, id),
    });

    if (existing) {
      if (data.avatarS3Key !== existing.avatarS3Key && existing.avatarS3Key) {
        await deleteObject(existing.avatarS3Key).catch(() => {});
      }
      if (data.heroS3Key !== existing.heroS3Key && existing.heroS3Key) {
        await deleteObject(existing.heroS3Key).catch(() => {});
      }
    }
  }

  const updateData: Record<string, any> = { ...data, updatedAt: new Date() };

  if (data.avatarS3Key !== undefined) {
    updateData.avatarUpdatedAt = new Date();
  }
  if (data.heroS3Key !== undefined) {
    updateData.heroUpdatedAt = new Date();
  }

  const [teacher] = await db
    .update(teachers)
    .set(updateData)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  bumpVersion("teachers").catch((err) =>
    console.error("[sync] failed to bump teachers version:", err),
  );
  return c.json(teacher);
});

teacherRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [teacher] = await db
    .delete(teachers)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  bumpVersion("teachers").catch((err) =>
    console.error("[sync] failed to bump teachers version:", err),
  );
  return c.json(teacher);
});

export { teacherRoutes };
