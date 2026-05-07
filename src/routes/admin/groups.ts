import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { createRetreatGroupSchema, updateRetreatGroupSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  putObject,
  deleteObject,
  buildGroupAvatarS3Key,
  buildGroupHeroS3Key,
} from "../../services/s3.ts";
import { processAvatar, processHero } from "../../services/image-pipeline.ts";
import { resolveGroupUrls } from "../../lib/group-utils.ts";

const groupRoutes = new Hono();

const columns: Record<string, any> = {
  id: retreatGroups.id,
  nameEn: retreatGroups.nameEn,
  namePt: retreatGroups.namePt,
  abbreviation: retreatGroups.abbreviation,
  slug: retreatGroups.slug,
  displayOrder: retreatGroups.displayOrder,
  createdAt: retreatGroups.createdAt,
};

groupRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(retreatGroups.nameEn, `%${q}%`),
        ilike(retreatGroups.namePt, `%${q}%`),
        ilike(retreatGroups.abbreviation, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(retreatGroups).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(retreatGroups, where),
  ]);

  const resolved = await Promise.all(
    data.map(async (g) => ({ ...g, ...(await resolveGroupUrls(g)) })),
  );
  return listResponse(c, resolved, total, offset, offset + limit, "groups");
});

groupRoutes.put("/reorder", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(retreatGroups)
      .set({ displayOrder: i, updatedAt: new Date() })
      .where(eq(retreatGroups.id, ids[i]!));
  }
  return c.json({ success: true });
});

/**
 * POST /:id/avatar — Upload and resize a retreat-group avatar.
 *
 * Accepts multipart/form-data with a `file` field. The server resizes to
 * 400×400 (sharp center-cover) before storing on S3.
 */
groupRoutes.post("/:id/avatar", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");

  const buffer = Buffer.from(await file.arrayBuffer());
  const resized = await processAvatar(buffer);

  const s3Key = buildGroupAvatarS3Key(id, "jpg");
  await putObject(s3Key, resized, "image/jpeg");

  const existing = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (existing?.avatarS3Key && existing.avatarS3Key !== s3Key) {
    await deleteObject(existing.avatarS3Key).catch(() => {});
  }

  const now = new Date();
  const [group] = await db
    .update(retreatGroups)
    .set({ avatarS3Key: s3Key, avatarUpdatedAt: now, updatedAt: now })
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");

  const resolved = await resolveGroupUrls(group);
  return c.json({ ...group, ...resolved });
});

/**
 * POST /:id/hero — Upload and resize a retreat-group hero banner.
 *
 * Accepts multipart/form-data with `file` and optional `focalX`/`focalY`
 * (0–100, default 50). The server resizes to 1200px wide.
 */
groupRoutes.post("/:id/hero", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) throw AppError.badRequest("Invalid group ID");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw AppError.badRequest("Missing file");
  const focalX = clampPercent(form.get("focalX"));
  const focalY = clampPercent(form.get("focalY"));

  const buffer = Buffer.from(await file.arrayBuffer());
  const resized = await processHero(buffer);

  const s3Key = buildGroupHeroS3Key(id, "jpg");
  await putObject(s3Key, resized, "image/jpeg");

  const existing = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (existing?.heroS3Key && existing.heroS3Key !== s3Key) {
    await deleteObject(existing.heroS3Key).catch(() => {});
  }

  const now = new Date();
  const [group] = await db
    .update(retreatGroups)
    .set({
      heroS3Key: s3Key,
      heroFocalX: focalX,
      heroFocalY: focalY,
      heroScale: 100,
      heroUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");

  const resolved = await resolveGroupUrls(group);
  return c.json({ ...group, ...resolved });
});

function clampPercent(raw: FormDataEntryValue | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

groupRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const group = await db.query.retreatGroups.findFirst({
    where: eq(retreatGroups.id, id),
  });
  if (!group) throw AppError.notFound("Group not found");
  const resolved = await resolveGroupUrls(group);
  return c.json({ ...group, ...resolved });
});

groupRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createRetreatGroupSchema.parse(body);
  const [group] = await db.insert(retreatGroups).values(data).returning();
  return c.json(group!, 201);
});

groupRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateRetreatGroupSchema.parse(body);

  // If S3 keys are changing, delete the previous objects.
  if (data.avatarS3Key !== undefined || data.heroS3Key !== undefined) {
    const existing = await db.query.retreatGroups.findFirst({
      where: eq(retreatGroups.id, id),
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
    // Group hero images are generic (Buddha statues, mandalas, etc.) — no
    // automatic face/focal-point detection. The admin sets focal+scale by
    // hand from the crop dialog; defaults to centered if unset.
  }

  const [group] = await db
    .update(retreatGroups)
    .set(updateData)
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");
  return c.json(group);
});

groupRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [group] = await db
    .delete(retreatGroups)
    .where(eq(retreatGroups.id, id))
    .returning();
  if (!group) throw AppError.notFound("Group not found");
  return c.json(group);
});

export { groupRoutes };
