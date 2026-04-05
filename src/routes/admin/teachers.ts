import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../db/index.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { createTeacherSchema, updateTeacherSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  generatePresignedUploadUrl,
  generatePresignedDownloadUrl,
  deleteObject,
  buildTeacherAvatarS3Key,
  buildTeacherHeroS3Key,
} from "../../services/s3.ts";
import { resolveTeacherUrls } from "../../lib/teacher-utils.ts";

/**
 * Detect the focal point of an image using sharp's attention strategy.
 * Crops to a narrow horizontal strip and reads where the attention center is.
 * Returns { x, y } as percentages (0-100).
 */
async function detectFocalPoint(imageBuffer: Buffer): Promise<{ x: number; y: number }> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width!;
  const height = metadata.height!;

  // Crop to a narrow strip (1/3 width, 1/3 height) using attention strategy
  // The crop offset tells us where the interesting content is
  const targetW = Math.round(width * 0.33);
  const targetH = Math.round(height * 0.33);

  const { info } = await sharp(imageBuffer)
    .resize(targetW, targetH, { fit: "cover", position: "attention" })
    .toBuffer({ resolveWithObject: true });

  // cropOffsetLeft/Top tell us how many pixels were trimmed from the left/top
  const cropLeft = (info as any).cropOffsetLeft ?? 0;
  const cropTop = (info as any).cropOffsetTop ?? 0;

  // The center of the visible area in the original image
  const focalX = Math.round(((cropLeft + targetW / 2) / width) * 100);
  const focalY = Math.round(((cropTop + targetH / 2) / height) * 100);

  return {
    x: Math.max(0, Math.min(100, focalX)),
    y: Math.max(0, Math.min(100, focalY)),
  };
}

/**
 * Detect the attention region of an image. Returns center coordinates (0-1)
 * and the approximate fraction of the image the subject occupies.
 * Used to auto-frame faces in the avatar crop dialog.
 */
async function detectAttentionRegion(
  imageBuffer: Buffer,
): Promise<{ centerX: number; centerY: number; subjectSize: number }> {
  const metadata = await sharp(imageBuffer).metadata();
  const w = metadata.width!;
  const h = metadata.height!;
  const minDim = Math.min(w, h);

  // Wide crop: 60% of min dimension square — gives rough center
  const wideSize = Math.round(minDim * 0.6);
  const { info: wideInfo } = await sharp(imageBuffer)
    .resize(wideSize, wideSize, { fit: "cover", position: "attention" })
    .toBuffer({ resolveWithObject: true });
  const wideLeft = (wideInfo as any).cropOffsetLeft ?? 0;
  const wideTop = (wideInfo as any).cropOffsetTop ?? 0;

  // Tight crop: 25% of min dimension — gives precise center
  const tightSize = Math.round(minDim * 0.25);
  const { info: tightInfo } = await sharp(imageBuffer)
    .resize(tightSize, tightSize, { fit: "cover", position: "attention" })
    .toBuffer({ resolveWithObject: true });
  const tightLeft = (tightInfo as any).cropOffsetLeft ?? 0;
  const tightTop = (tightInfo as any).cropOffsetTop ?? 0;

  // Center is the middle of the tight crop region
  const centerX = (tightLeft + tightSize / 2) / w;
  const centerY = (tightTop + tightSize / 2) / h;

  // Subject size estimate: how far the crop shifted between wide and tight
  // tells us how "spread out" the subject is
  const shiftX = Math.abs(tightLeft - wideLeft) / w;
  const shiftY = Math.abs(tightTop - wideTop) / h;
  const subjectSize = Math.max(0.15, Math.min(0.7, (shiftX + shiftY) * 2 + 0.2));

  return {
    centerX: Math.max(0, Math.min(1, centerX)),
    centerY: Math.max(0, Math.min(1, centerY)),
    subjectSize,
  };
}

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

teacherRoutes.post("/presign-upload", async (c) => {
  const { teacherId, type, contentType, filename } = (await c.req.json()) as {
    teacherId: number;
    type: "avatar" | "hero";
    contentType: string;
    filename: string;
  };

  const ext = filename.split(".").pop() || "jpg";
  const s3Key =
    type === "avatar"
      ? buildTeacherAvatarS3Key(teacherId, ext)
      : buildTeacherHeroS3Key(teacherId, ext);

  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

/**
 * POST /detect-face — Analyze an uploaded image to find the face/subject.
 * Returns center position (0-1) and suggested AvatarEditor scale.
 */
teacherRoutes.post("/detect-face", async (c) => {
  const body = await c.req.parseBody();
  const file = body["image"];
  if (!file || !(file instanceof File)) {
    throw AppError.badRequest("Missing image file");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const region = await detectAttentionRegion(buffer);

  // Calculate suggested scale for a 300x300 avatar editor:
  // If subject occupies ~30% of image, we want ~2.3x zoom to fill the circle
  const suggestedScale = Math.max(1.2, Math.min(3, 0.7 / region.subjectSize));

  return c.json({
    centerX: region.centerX,
    centerY: region.centerY,
    subjectSize: region.subjectSize,
    suggestedScale: Math.round(suggestedScale * 100) / 100,
  });
});

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

    // Auto-detect focal point when hero image changes
    if (data.heroS3Key) {
      try {
        const heroUrl = await generatePresignedDownloadUrl(data.heroS3Key);
        const response = await fetch(heroUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        const focal = await detectFocalPoint(buffer);
        updateData.heroFocalX = focal.x;
        updateData.heroFocalY = focal.y;
      } catch {
        // Fall back to defaults if detection fails
        updateData.heroFocalX = 50;
        updateData.heroFocalY = 33;
      }
    }
  }

  const [teacher] = await db
    .update(teachers)
    .set(updateData)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  return c.json(teacher);
});

teacherRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [teacher] = await db
    .delete(teachers)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  return c.json(teacher);
});

export { teacherRoutes };
