import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { retreatGroups } from "../../db/schema/retreat-groups.ts";
import { createRetreatGroupSchema, updateRetreatGroupSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  generatePresignedUploadUrl,
  deleteObject,
  buildGroupAvatarS3Key,
  buildGroupHeroS3Key,
} from "../../services/s3.ts";
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
 * POST /presign-upload — Get a presigned URL for uploading a group avatar
 * or hero image to S3. The admin uploads directly to S3 with the returned
 * URL, then PUTs the resulting `s3Key` back via the resource update.
 */
groupRoutes.post("/presign-upload", async (c) => {
  const { groupId, type, contentType, filename } = (await c.req.json()) as {
    groupId: number;
    type: "avatar" | "hero";
    contentType: string;
    filename: string;
  };

  const ext = filename.split(".").pop() || "jpg";
  const s3Key =
    type === "avatar"
      ? buildGroupAvatarS3Key(groupId, ext)
      : buildGroupHeroS3Key(groupId, ext);

  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

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
